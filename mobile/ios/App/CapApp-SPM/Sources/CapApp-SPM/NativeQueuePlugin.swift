import Foundation
import AVFoundation
import MediaPlayer
import UIKit
import Capacitor

/// B-Side's player on iOS: AVPlayer through the native audio stack, holding the
/// QUEUE itself.
///
/// Why native, and why the queue lives here (both lessons from the Bookshelf app,
/// whose NativeAudioPlugin this is modelled on):
///   - the web `<audio>` element in a WKWebView is suspended and resumed whenever
///     the screen locks, which drops a moment of sound; AVPlayer never is;
///   - with the screen locked the WebView is FROZEN, so JS cannot load the next
///     song when one ends. A playlist would stop after one song. So JS hands over
///     the whole list (`setQueue`) and this plugin moves through it by itself, and
///     the lock screen's next/previous act here too. JS only mirrors what it is
///     told (`track`, `state`, `time`, `finished`, `error`).
///
/// Registered via `packageClassList` in capacitor.config.json — see
/// mobile/scripts/register-native-plugins.mjs, which re-adds it after every
/// `cap sync` (sync rebuilds that list from npm plugins only).
@objc(NativeQueuePlugin)
public class NativeQueuePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeQueuePlugin"
    public let jsName = "NativeQueue"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setQueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "next", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "previous", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
    ]

    private struct Item {
        let key: String
        let url: URL
        let title: String
        let artist: String
        let album: String
    }

    private var queue: [Item] = []
    private var currentKey: String?
    private var player: AVPlayer?
    private var timeObserver: Any?
    private var statusObs: NSKeyValueObservation?
    private var stateObs: NSKeyValueObservation?
    private var lastState: Bool?
    private var duration: Double = 0
    private var commandsWired = false
    private var interruptionWired = false
    private var lifecycleWired = false
    private var npInfo: [String: Any] = [:]

    /// 2 Hz in front (a scrubber to move), 1 Hz behind it: every tick is a call
    /// into the WebView process, and with the screen off there is nothing to show.
    private static let fgTickSeconds = 0.5
    private static let bgTickSeconds = 1.0
    private var tickSeconds = NativeQueuePlugin.fgTickSeconds

    /// Previous restarts the song after this many seconds, as every player does.
    private static let restartAfter = 3.0

    // ── Transient load failures are waited out, not reported (Bookshelf, 2026-09-29) ──
    // A hub slow to send the first byte fails the item with NSURLErrorTimedOut;
    // the second open works. That is weather: the item is rebuilt on a stated
    // budget, and only a failure past it (or one that is not a network hiccup)
    // reaches JS as "error".
    private var loadSerial = 0
    private static let loadRetryDelays: [Double] = [1, 3, 6]
    private static let transientLoadErrors: Set<Int> = [
        NSURLErrorTimedOut, NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost,
        NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed,
    ]

    private static func urlErrorCode(_ error: Error?) -> Int? {
        guard let e = error as NSError? else { return nil }
        if e.domain == NSURLErrorDomain { return e.code }
        if let u = e.userInfo[NSUnderlyingErrorKey] as? NSError, u.domain == NSURLErrorDomain { return u.code }
        return nil
    }

    // MARK: - JS API

    /// Replace the queue. With a `key`, load that song from its start (and play
    /// when `play`); without one, keep whatever is playing and only change what
    /// comes before and after it (a song landed in the playing list, one was
    /// removed, a playlist was reordered).
    @objc func setQueue(_ call: CAPPluginCall) {
        let raw = call.getArray("items") ?? []
        var items: [Item] = []
        for entry in raw {
            guard let o = entry as? [String: Any],
                  let key = o["key"] as? String,
                  let s = o["url"] as? String, let url = URL(string: s) else {
                call.reject("setQueue: every item needs a key and a url"); return
            }
            items.append(Item(key: key, url: url,
                              title: o["title"] as? String ?? "",
                              artist: o["artist"] as? String ?? "",
                              album: o["album"] as? String ?? ""))
        }
        let key = call.getString("key")
        let play = call.getBool("play") ?? false
        DispatchQueue.main.async {
            self.queue = items
            if let key = key {
                guard let item = items.first(where: { $0.key == key }) else {
                    call.reject("setQueue: \(key) is not in the queue"); return
                }
                self.load(item, play: play)
            }
            call.resolve()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.doPlay(); call.resolve() }
    }

    @objc func pause(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.doPause(); call.resolve() }
    }

    @objc func seek(_ call: CAPPluginCall) {
        let time = call.getDouble("time") ?? 0
        DispatchQueue.main.async { self.seekTo(time); call.resolve() }
    }

    @objc func next(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.step(1, ended: false); call.resolve() }
    }

    @objc func previous(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.previousSong(); call.resolve() }
    }

    @objc func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.teardownPlayer()
            self.currentKey = nil
            self.npInfo = [:]
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            call.resolve()
        }
    }

    // MARK: - the queue

    private func index() -> Int? {
        guard let key = currentKey else { return nil }
        return queue.firstIndex(where: { $0.key == key })
    }

    /// Move through the queue. At the end of the last song, say `finished`: on the
    /// playing list JS starts the next song the moment it lands.
    private func step(_ by: Int, ended: Bool) {
        guard let at = index() else { return }
        let target = at + by
        if target >= 0, target < queue.count {
            load(queue[target], play: true)
        } else if ended {
            emitState(false)
            updateNowPlaying(playing: false)
            notifyListeners("finished", data: [:])
        }
    }

    private func previousSong() {
        let now = player?.currentTime().seconds ?? 0
        if now > NativeQueuePlugin.restartAfter || (index() ?? 0) <= 0 {
            seekTo(0)
        } else {
            step(-1, ended: false)
        }
    }

    private func load(_ item: Item, play: Bool) {
        configureSessionCategory()
        wireInterruptions()
        wireLifecycle()
        wireRemoteCommands()
        teardownPlayer()
        currentKey = item.key
        let player = AVPlayer()
        player.automaticallyWaitsToMinimizeStalling = true
        self.player = player
        loadSerial += 1
        replaceItem(on: player, url: item.url, serial: loadSerial, attempt: 0)
        installTimeObserver()
        lastState = nil
        // System pauses (headphones out, another app's audio) never pass through
        // pause(): mirror the real transport state from here.
        stateObs = player.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                let playing = p.timeControlStatus != .paused
                self.emitState(playing)
                self.updateNowPlaying(playing: playing)
            }
        }
        npInfo = [
            MPMediaItemPropertyTitle: item.title,
            MPMediaItemPropertyArtist: item.artist,
            MPMediaItemPropertyAlbumTitle: item.album,
        ]
        notifyListeners("track", data: ["key": item.key])
        if play { doPlay() } else { updateNowPlaying(playing: false) }
    }

    private func replaceItem(on player: AVPlayer, url: URL, serial: Int, attempt: Int) {
        NotificationCenter.default.removeObserver(self, name: .AVPlayerItemDidPlayToEndTime, object: nil)
        let item = AVPlayerItem(url: url)
        statusObs?.invalidate()
        statusObs = item.observe(\.status, options: [.new]) { [weak self] it, _ in
            guard let self = self else { return }
            if it.status == .readyToPlay {
                let d = it.duration.seconds
                self.duration = d.isFinite ? d : 0
                self.updateNowPlaying(playing: self.player?.timeControlStatus != .paused)
            } else if it.status == .failed {
                let code = NativeQueuePlugin.urlErrorCode(it.error)
                if let code = code, NativeQueuePlugin.transientLoadErrors.contains(code),
                   attempt < NativeQueuePlugin.loadRetryDelays.count {
                    let delay = NativeQueuePlugin.loadRetryDelays[attempt]
                    print("[NativeQueue] load failed transiently (NSURLError \(code)); retry \(attempt + 1) in \(delay)s")
                    DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                        // Only the load that failed is retried: a newer load supersedes it.
                        guard let self = self, self.loadSerial == serial, let p = self.player else { return }
                        self.replaceItem(on: p, url: url, serial: serial, attempt: attempt + 1)
                        if NativeQueuePlugin.isPlaying { p.play() }
                    }
                    return
                }
                let reason = it.error?.localizedDescription ?? "load failed"
                let suffix = code.map { " (NSURLError \($0))" } ?? ""
                self.notifyListeners("error", data: ["message": reason + suffix])
            }
        }
        NotificationCenter.default.addObserver(self, selector: #selector(didEnd), name: .AVPlayerItemDidPlayToEndTime, object: item)
        player.replaceCurrentItem(with: item)
    }

    @objc private func didEnd() {
        DispatchQueue.main.async { self.step(1, ended: true) }
    }

    // MARK: - transport

    /// True while B-Side is playing. Activating a .playback session interrupts
    /// other apps, so it happens only when B-Side really plays.
    public private(set) static var isPlaying = false

    private func doPlay() {
        guard let player = player else { return }
        activateSession()
        NativeQueuePlugin.isPlaying = true
        player.play()
        emitState(true)
        updateNowPlaying(playing: true)
    }

    private func doPause() {
        NativeQueuePlugin.isPlaying = false
        player?.pause()
        emitState(false)
        updateNowPlaying(playing: false)
    }

    private func seekTo(_ seconds: Double) {
        guard let player = player else { return }
        let clamped = duration > 0 ? max(0, min(seconds, duration)) : max(0, seconds)
        player.seek(to: CMTime(seconds: clamped, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            guard let self = self else { return }
            self.updateNowPlaying(playing: self.player?.timeControlStatus != .paused)
            self.notifyListeners("time", data: ["time": clamped, "duration": self.duration])
        }
    }

    /// One `state` event per change: the status observer echoes our own play/pause.
    private func emitState(_ playing: Bool) {
        if lastState == playing { return }
        lastState = playing
        notifyListeners("state", data: ["playing": playing])
    }

    private func teardownPlayer() {
        if let t = timeObserver { player?.removeTimeObserver(t); timeObserver = nil }
        loadSerial += 1   // a retry pending for the item being torn down must not fire
        statusObs?.invalidate(); statusObs = nil
        stateObs?.invalidate(); stateObs = nil
        NotificationCenter.default.removeObserver(self, name: .AVPlayerItemDidPlayToEndTime, object: nil)
        player?.pause()
        player = nil
        duration = 0
        NativeQueuePlugin.isPlaying = false
    }

    // MARK: - the audio session

    /// Music, not spoken audio: B-Side plays songs.
    private func configureSessionCategory() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        } catch {
            print("[NativeQueue] setCategory failed: \(error.localizedDescription)")
            notifyListeners("error", data: ["message": "The phone's audio session could not be set up: \(error.localizedDescription)"])
        }
    }

    private func activateSession() {
        configureSessionCategory()
        let s = AVAudioSession.sharedInstance()
        do {
            try s.setActive(true)
        } catch {
            // Routinely transient right after a call or an alarm: try once more, and
            // let a real failure show as the item's own `.failed` status.
            print("[NativeQueue] setActive(true) failed, retrying: \(error.localizedDescription)")
            do { try s.setActive(true) } catch {
                print("[NativeQueue] setActive(true) retry failed: \(error.localizedDescription)")
            }
        }
    }

    private func wireInterruptions() {
        if interruptionWired { return }
        interruptionWired = true
        NotificationCenter.default.addObserver(self, selector: #selector(handleInterruption(_:)),
                                               name: AVAudioSession.interruptionNotification, object: nil)
    }

    /// A phone call or Siri: pause, and resume afterwards when iOS says to.
    @objc private func handleInterruption(_ note: Notification) {
        guard let info = note.userInfo,
              let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        DispatchQueue.main.async {
            switch type {
            case .began:
                NativeQueuePlugin.isPlaying = false
                self.emitState(false)
                self.updateNowPlaying(playing: false)
            case .ended:
                let opts = AVAudioSession.InterruptionOptions(rawValue: info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
                if opts.contains(.shouldResume) { self.doPlay() }
            @unknown default: break
            }
        }
    }

    // MARK: - time ticks (slower in the background)

    private func installTimeObserver() {
        guard let player = player else { return }
        if let t = timeObserver { player.removeTimeObserver(t); timeObserver = nil }
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: tickSeconds, preferredTimescale: 600), queue: .main) { [weak self] t in
            guard let self = self else { return }
            let cur = t.seconds
            self.notifyListeners("time", data: ["time": cur.isFinite ? cur : 0, "duration": self.duration])
        }
    }

    private func wireLifecycle() {
        guard !lifecycleWired else { return }
        lifecycleWired = true
        NotificationCenter.default.addObserver(self, selector: #selector(appDidEnterBackground),
                                               name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(appWillEnterForeground),
                                               name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    @objc private func appDidEnterBackground() { setTick(NativeQueuePlugin.bgTickSeconds) }
    @objc private func appWillEnterForeground() { setTick(NativeQueuePlugin.fgTickSeconds) }

    private func setTick(_ s: Double) {
        DispatchQueue.main.async {
            guard self.tickSeconds != s else { return }
            self.tickSeconds = s
            guard self.player != nil else { return }
            self.installTimeObserver()
            // Back in front: JS sees which song is playing now (it may have moved on while frozen).
            if s == NativeQueuePlugin.fgTickSeconds, let key = self.currentKey {
                self.notifyListeners("track", data: ["key": key])
                self.notifyListeners("state", data: ["playing": NativeQueuePlugin.isPlaying])
            }
        }
    }

    // MARK: - lock screen

    /// The lock-screen card. iOS extrapolates the scrubber from elapsed time and
    /// rate, so this is written on changes only, never per tick (Bookshelf: per-tick
    /// writes were its largest continuous power draw).
    private func updateNowPlaying(playing: Bool) {
        guard !npInfo.isEmpty else { return }
        npInfo[MPMediaItemPropertyPlaybackDuration] = duration
        npInfo[MPNowPlayingInfoPropertyElapsedPlaybackTime] = player?.currentTime().seconds ?? 0
        npInfo[MPNowPlayingInfoPropertyPlaybackRate] = playing ? 1.0 : 0.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = npInfo
    }

    /// Lock screen, Control Center and headphones act HERE: JS may be frozen.
    private func wireRemoteCommands() {
        if commandsWired { return }
        commandsWired = true
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in
            DispatchQueue.main.async { self?.doPlay() }; return .success }
        c.pauseCommand.addTarget { [weak self] _ in
            DispatchQueue.main.async { self?.doPause() }; return .success }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                if NativeQueuePlugin.isPlaying { self.doPause() } else { self.doPlay() }
            }
            return .success }
        c.nextTrackCommand.addTarget { [weak self] _ in
            DispatchQueue.main.async { self?.step(1, ended: false) }; return .success }
        c.previousTrackCommand.addTarget { [weak self] _ in
            DispatchQueue.main.async { self?.previousSong() }; return .success }
        c.changePlaybackPositionCommand.addTarget { [weak self] ev in
            guard let e = ev as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            DispatchQueue.main.async { self?.seekTo(e.positionTime) }
            return .success
        }
    }
}
