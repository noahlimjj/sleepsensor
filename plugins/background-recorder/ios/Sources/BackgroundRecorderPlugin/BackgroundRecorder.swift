import Foundation
import UIKit
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

    // MARK: - Files: export share sheet + nightly copies in the Files app

    /// `export` = a scratch folder for the share sheet; `nights` = Documents,
    /// shown in Files → On My iPhone → Sleep Sensor (UIFileSharingEnabled).
    private func folder(_ kind: String, _ sub: String?) throws -> URL {
        let fm = FileManager.default
        var base: URL
        if kind == "nights" {
            base = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
        } else {
            base = fm.temporaryDirectory.appendingPathComponent("export", isDirectory: true)
        }
        if let sub = sub, !sub.isEmpty { base = base.appendingPathComponent(safeName(sub), isDirectory: true) }
        try fm.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    private func safeName(_ n: String) -> String {
        let bad = CharacterSet(charactersIn: "/\\:?%*|\"<>")
        return n.components(separatedBy: bad).joined(separator: "-")
    }

    /// writeFile({ kind, dir?, name, data (base64), append? })
    @objc func writeFile(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), let b64 = call.getString("data"),
              let data = Data(base64Encoded: b64) else {
            call.reject("name and base64 data are required"); return
        }
        do {
            let url = try folder(call.getString("kind") ?? "export", call.getString("dir")).appendingPathComponent(safeName(name))
            if call.getBool("append") ?? false, FileManager.default.fileExists(atPath: url.path) {
                let h = try FileHandle(forWritingTo: url)
                h.seekToEndOfFile()
                h.write(data)
                h.closeFile()
            } else {
                try data.write(to: url, options: .atomic)
            }
            call.resolve(["path": url.path])
        } catch {
            call.reject("write failed: \(error.localizedDescription)")
        }
    }

    /// clearFiles({ kind, dir? }) — empties the export scratch folder (or one night)
    @objc func clearFiles(_ call: CAPPluginCall) {
        do {
            let url = try folder(call.getString("kind") ?? "export", call.getString("dir"))
            try? FileManager.default.removeItem(at: url)
            call.resolve()
        } catch {
            call.resolve()
        }
    }

    /// listDirs({ kind }) -> { dirs: [String] } (nights folder housekeeping)
    @objc func listDirs(_ call: CAPPluginCall) {
        do {
            let url = try folder(call.getString("kind") ?? "nights", nil)
            let items = try FileManager.default.contentsOfDirectory(atPath: url.path)
            call.resolve(["dirs": items.sorted()])
        } catch {
            call.resolve(["dirs": []])
        }
    }

    /// shareFiles({ kind, dir?, names: [String] }) — native share sheet
    /// (AirDrop, Save to Files, Telegram, Mail …)
    @objc func shareFiles(_ call: CAPPluginCall) {
        let names = call.getArray("names", String.self) ?? []
        do {
            let dir = try folder(call.getString("kind") ?? "export", call.getString("dir"))
            let urls = names.map { dir.appendingPathComponent(safeName($0)) }
                .filter { FileManager.default.fileExists(atPath: $0.path) }
            if urls.isEmpty { call.reject("no files to share"); return }
            DispatchQueue.main.async {
                guard let vc = self.bridge?.viewController else { call.reject("no view controller"); return }
                let sheet = UIActivityViewController(activityItems: urls, applicationActivities: nil)
                if let pop = sheet.popoverPresentationController {
                    pop.sourceView = vc.view
                    pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 1, height: 1)
                    pop.permittedArrowDirections = []
                }
                sheet.completionWithItemsHandler = { activity, completed, _, error in
                    if let error = error { call.reject(error.localizedDescription); return }
                    call.resolve(["completed": completed, "activity": activity?.rawValue ?? ""])
                }
                vc.present(sheet, animated: true)
            }
        } catch {
            call.reject("share failed: \(error.localizedDescription)")
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
