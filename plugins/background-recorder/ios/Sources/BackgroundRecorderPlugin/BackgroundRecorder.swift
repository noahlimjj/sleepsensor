import Foundation
import AVFoundation
import Capacitor
import MediaPlayer

/*
 * BackgroundRecorder (iOS) — keeps SleepSensor alive while the screen is locked.
 *
 * iOS lets an app keep running in the background only while it is actively
 * using audio and declares UIBackgroundModes = ["audio"]. We hold an active
 * AVAudioSession (.playAndRecord) and keep a silent buffer looping through
 * AVAudioPlayer, so the WebView's own getUserMedia + AudioWorklet continue to
 * run and process audio all night. Interruptions (calls, alarms, Siri, another
 * app grabbing the mic) are forwarded to JS so the engine can resume.
 */
@objc(BackgroundRecorder)
public class BackgroundRecorder: CAPPlugin {

    private var player: AVAudioPlayer?
    private var running = false

    override public func load() {
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(handleInterruption(_:)),
                       name: AVAudioSession.interruptionNotification, object: nil)
        nc.addObserver(self, selector: #selector(handleRouteChange(_:)),
                       name: AVAudioSession.routeChangeNotification, object: nil)
        nc.addObserver(self, selector: #selector(handleMediaReset(_:)),
                       name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
    }

    // MARK: - Permissions

    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        let state = AVAudioSession.sharedInstance().recordPermission
        call.resolve(["microphone": mapPermission(state)])
    }

    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            call.resolve(["microphone": granted ? "granted" : "denied"])
        }
    }

    private func mapPermission(_ s: AVAudioSession.RecordPermission) -> String {
        switch s {
        case .granted: return "granted"
        case .denied: return "denied"
        default: return "prompt"
        }
    }

    // MARK: - Start / stop

    @objc func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playAndRecord,
                                        mode: .default,
                                        options: [.mixWithOthers, .allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker])
                try session.setActive(true, options: [])
                self.startSilentLoop()
                self.running = true
                call.resolve(["started": true])
            } catch {
                // Non-fatal fallback: still attempt to start silent player and resolve
                print("[BackgroundRecorder] AudioSession setup warning: \(error.localizedDescription)")
                self.startSilentLoop()
                self.running = true
                call.resolve(["started": true, "warning": error.localizedDescription])
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.stopSilentLoop()
            try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
            self.running = false
            call.resolve()
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve()
        }
    }

    // battery optimisation is Android-only
    @objc func isBatteryOptimizationExempt(_ call: CAPPluginCall) { call.resolve(["exempt": true]) }
    @objc func requestBatteryOptimizationExemption(_ call: CAPPluginCall) { call.resolve(["exempt": true]) }

    // MARK: - Silent keep-alive (AVAudioPlayer loop)

    private func makeSilentWavData() -> Data {
        let sampleRate: UInt32 = 44100
        let numChannels: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let byteRate: UInt32 = sampleRate * UInt32(numChannels) * UInt32(bitsPerSample / 8)
        let blockAlign: UInt16 = numChannels * (bitsPerSample / 8)
        let numSamples: UInt32 = sampleRate // 1 second of silence
        let dataSize: UInt32 = numSamples * UInt32(blockAlign)
        let chunkSize: UInt32 = 36 + dataSize

        var data = Data()
        data.append(contentsOf: "RIFF".utf8)
        var cs = chunkSize.littleEndian; data.append(Data(bytes: &cs, count: 4))
        data.append(contentsOf: "WAVE".utf8)
        data.append(contentsOf: "fmt ".utf8)
        var subchunk1Size: UInt32 = 16; var sc1 = subchunk1Size.littleEndian; data.append(Data(bytes: &sc1, count: 4))
        var audioFormat: UInt16 = 1; var af = audioFormat.littleEndian; data.append(Data(bytes: &af, count: 2))
        var nc = numChannels.littleEndian; data.append(Data(bytes: &nc, count: 2))
        var sr = sampleRate.littleEndian; data.append(Data(bytes: &sr, count: 4))
        var br = byteRate.littleEndian; data.append(Data(bytes: &br, count: 4))
        var ba = blockAlign.littleEndian; data.append(Data(bytes: &ba, count: 2))
        var bps = bitsPerSample.littleEndian; data.append(Data(bytes: &bps, count: 2))
        data.append(contentsOf: "data".utf8)
        var ds = dataSize.littleEndian; data.append(Data(bytes: &ds, count: 4))
        data.append(Data(count: Int(dataSize))) // all zeroes = pure silence
        return data
    }

    private func startSilentLoop() {
        stopSilentLoop()
        do {
            let wavData = makeSilentWavData()
            let p = try AVAudioPlayer(data: wavData)
            p.numberOfLoops = -1 // loop indefinitely
            p.volume = 0.0      // silent
            p.prepareToPlay()
            p.play()
            self.player = p
        } catch {
            print("[BackgroundRecorder] Failed to create silent AVAudioPlayer: \(error.localizedDescription)")
        }
    }

    private func stopSilentLoop() {
        player?.stop()
        player = nil
    }

    // MARK: - Notifications -> JS

    @objc private func handleInterruption(_ n: Notification) {
        guard let info = n.userInfo,
              let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began {
            player?.pause()
            notifyListeners("interruptionBegan", data: [:])
        } else {
            // try to reactivate and tell JS to resume
            try? AVAudioSession.sharedInstance().setActive(true, options: [])
            player?.play()
            notifyListeners("interruptionEnded", data: [:])
        }
    }

    @objc private func handleRouteChange(_ n: Notification) {
        var reason = "unknown"
        if let info = n.userInfo,
           let raw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
           let r = AVAudioSession.RouteChangeReason(rawValue: raw) {
            switch r {
            case .newDeviceAvailable: reason = "device-added"
            case .oldDeviceUnavailable: reason = "device-removed"
            case .override: reason = "override"
            default: reason = "other"
            }
        }
        notifyListeners("routeChange", data: ["reason": reason])
    }

    @objc private func handleMediaReset(_ n: Notification) {
        // the whole audio stack was reset by the OS — rebuild and tell JS
        stopSilentLoop()
        if running {
            startSilentLoop()
            notifyListeners("interruptionEnded", data: ["reason": "media-reset"])
        }
    }
}
