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
 * AVAudioEngine, so the WebView's own getUserMedia + AudioWorklet continue to
 * run and process audio all night. Interruptions (calls, alarms, Siri, another
 * app grabbing the mic) are forwarded to JS so the engine can resume.
 *
 * Copy this file + BackgroundRecorder.m into ios/App/App/ after `npx cap add ios`.
 * Add to Info.plist:  NSMicrophoneUsageDescription,  UIBackgroundModes -> audio
 */
@objc(BackgroundRecorder)
public class BackgroundRecorder: CAPPlugin {

    private let engine = AVAudioEngine()
    private var player: AVAudioPlayerNode?
    private var silentBuffer: AVAudioPCMBuffer?
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
        let title = call.getString("title") ?? "SleepSensor"
        let text = call.getString("text") ?? "Monitoring your sleep…"
        DispatchQueue.main.async {
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playAndRecord,
                                        mode: .default,
                                        options: [.mixWithOthers, .allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker])
                try session.setActive(true, options: [])
                try self.startSilentLoop()
                self.setNowPlaying(title: title, text: text)
                self.running = true
                call.resolve(["started": true])
            } catch {
                call.reject("audio session: \(error.localizedDescription)")
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.stopSilentLoop()
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
            self.running = false
            call.resolve()
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? ""
        DispatchQueue.main.async {
            self.setNowPlaying(title: "SleepSensor", text: text)
            call.resolve()
        }
    }

    // battery optimisation is Android-only
    @objc func isBatteryOptimizationExempt(_ call: CAPPluginCall) { call.resolve(["exempt": true]) }
    @objc func requestBatteryOptimizationExemption(_ call: CAPPluginCall) { call.resolve(["exempt": true]) }

    // MARK: - Silent keep-alive

    private func startSilentLoop() throws {
        let fmt = engine.outputNode.inputFormat(forBus: 0)
        let node = AVAudioPlayerNode()
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: fmt)

        let frames = AVAudioFrameCount(fmt.sampleRate) // 1 second
        guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames) else { return }
        buf.frameLength = frames // zeroed => silence
        self.silentBuffer = buf
        self.player = node

        if !engine.isRunning { try engine.start() }
        node.play()
        scheduleSilence()
    }

    private func scheduleSilence() {
        guard let node = player, let buf = silentBuffer else { return }
        node.scheduleBuffer(buf, at: nil, options: [.loops], completionHandler: nil)
    }

    private func stopSilentLoop() {
        player?.stop()
        if engine.isRunning { engine.stop() }
        if let node = player { engine.detach(node) }
        player = nil
        silentBuffer = nil
    }

    private func setNowPlaying(title: String, text: String) {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: text,
            MPNowPlayingInfoPropertyIsLiveStream: true
        ]
    }

    // MARK: - Notifications -> JS

    @objc private func handleInterruption(_ n: Notification) {
        guard let info = n.userInfo,
              let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began {
            notifyListeners("interruptionBegan", data: [:])
        } else {
            // try to reactivate and tell JS to resume
            try? AVAudioSession.sharedInstance().setActive(true, options: [])
            if let node = player, !node.isPlaying { node.play(); scheduleSilence() }
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
            try? startSilentLoop()
            notifyListeners("interruptionEnded", data: ["reason": "media-reset"])
        }
    }
}
