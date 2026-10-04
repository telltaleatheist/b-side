import Foundation
import Capacitor

/// The phone's own B-Side hub (src/app/phone/phone-hub.ts) keeps its files here:
/// the shared core's `Disk` (shared/core/disk.ts) over Documents/bside.
///
///   hub/       the take cache (the playing list) and pending jobs: kept out of
///              backups, it clears itself.
///   library/   saved songs and playlists: backed up with the phone, like any
///              music the person chose to keep.
///
/// Paths are relative to Documents/bside and may not climb out of it. Songs are
/// DOWNLOADED straight to disk by URLSession, with the Crucible token in the
/// header, never passed through the bridge as base64 (Bookshelf learned that a
/// large file base64'd into one string out-of-memory-reloads the WebView).
@objc(NativeDiskPlugin)
public class NativeDiskPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeDiskPlugin"
    public let jsName = "NativeDisk"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "root", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mkdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exists", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "move", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
    ]

    private let files = FileManager.default

    private func rootDir() throws -> URL {
        let docs = files.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("bside", isDirectory: true)
        if !files.fileExists(atPath: dir.path) {
            try files.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    /// A relative path that stays inside the root: no leading slash, no `..`, no empty parts.
    private func resolve(_ path: String?) -> URL? {
        guard let path = path, !path.isEmpty, !path.hasPrefix("/") else { return nil }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return nil }
        guard let root = try? rootDir() else { return nil }
        return parts.reduce(root) { $0.appendingPathComponent(String($1)) }
    }

    /// The take cache clears itself: it never belongs in a backup.
    private func settle(_ url: URL, _ path: String) {
        guard path.hasPrefix("hub/") else { return }
        var mutable = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? mutable.setResourceValues(values)
    }

    private func parent(_ url: URL) throws {
        let dir = url.deletingLastPathComponent()
        if !files.fileExists(atPath: dir.path) {
            try files.createDirectory(at: dir, withIntermediateDirectories: true)
        }
    }

    /// Replace `to` with `from` in one move.
    private func replace(_ to: URL, with from: URL) throws {
        try parent(to)
        if files.fileExists(atPath: to.path) {
            _ = try files.replaceItemAt(to, withItemAt: from)
        } else {
            try files.moveItem(at: from, to: to)
        }
    }

    @objc func root(_ call: CAPPluginCall) {
        do {
            call.resolve(["url": try rootDir().absoluteString])
        } catch {
            call.reject("root: \(error.localizedDescription)")
        }
    }

    @objc func mkdir(_ call: CAPPluginCall) {
        guard let url = resolve(call.getString("path")) else { call.reject("mkdir: needs a path inside B-Side's folder"); return }
        do {
            try files.createDirectory(at: url, withIntermediateDirectories: true)
            call.resolve()
        } catch {
            call.reject("mkdir: \(error.localizedDescription)")
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        guard let url = resolve(call.getString("path")) else { call.reject("list: needs a path inside B-Side's folder"); return }
        var isDir: ObjCBool = false
        guard files.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else {
            call.resolve(["names": NSNull()]); return
        }
        do {
            call.resolve(["names": try files.contentsOfDirectory(atPath: url.path)])
        } catch {
            // A failed listing must THROW in JS: an empty answer would read as "nothing saved".
            call.reject("list: \(error.localizedDescription)")
        }
    }

    @objc func readText(_ call: CAPPluginCall) {
        guard let url = resolve(call.getString("path")) else { call.reject("readText: needs a path inside B-Side's folder"); return }
        guard files.fileExists(atPath: url.path) else { call.resolve(["text": NSNull()]); return }
        do {
            call.resolve(["text": try String(contentsOf: url, encoding: .utf8)])
        } catch {
            call.reject("readText: \(error.localizedDescription)")
        }
    }

    @objc func writeText(_ call: CAPPluginCall) {
        guard let path = call.getString("path"), let url = resolve(path), let text = call.getString("text") else {
            call.reject("writeText: needs a path inside B-Side's folder and text"); return
        }
        do {
            try parent(url)
            // .atomic: written beside, then renamed into place.
            try text.data(using: .utf8)!.write(to: url, options: .atomic)
            settle(url, path)
            call.resolve()
        } catch {
            call.reject("writeText: \(error.localizedDescription)")
        }
    }

    @objc func exists(_ call: CAPPluginCall) {
        guard let url = resolve(call.getString("path")) else { call.reject("exists: needs a path inside B-Side's folder"); return }
        call.resolve(["exists": files.fileExists(atPath: url.path)])
    }

    @objc func move(_ call: CAPPluginCall) {
        guard let path = call.getString("to"), let from = resolve(call.getString("from")), let to = resolve(path) else {
            call.reject("move: needs two paths inside B-Side's folder"); return
        }
        do {
            try replace(to, with: from)
            settle(to, path)
            call.resolve()
        } catch {
            call.reject("move: \(error.localizedDescription)")
        }
    }

    @objc func copy(_ call: CAPPluginCall) {
        guard let path = call.getString("to"), let from = resolve(call.getString("from")), let to = resolve(path) else {
            call.reject("copy: needs two paths inside B-Side's folder"); return
        }
        do {
            // Copied beside, then moved into place: an interrupted copy never sits under `to`.
            let temporary = to.appendingPathExtension("writing")
            try parent(to)
            if files.fileExists(atPath: temporary.path) { try files.removeItem(at: temporary) }
            try files.copyItem(at: from, to: temporary)
            try replace(to, with: temporary)
            settle(to, path)
            call.resolve()
        } catch {
            call.reject("copy: \(error.localizedDescription)")
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let url = resolve(call.getString("path")) else { call.reject("remove: needs a path inside B-Side's folder"); return }
        do {
            if files.fileExists(atPath: url.path) { try files.removeItem(at: url) }
            call.resolve()
        } catch {
            call.reject("remove: \(error.localizedDescription)")
        }
    }

    /// Download `url` to `path` with `headers` (the Crucible token). A network
    /// failure rejects with code "unreachable", so the job runner retries it.
    @objc func download(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let source = URL(string: s), let path = call.getString("path"), let target = resolve(path) else {
            call.reject("download: needs a url and a path inside B-Side's folder"); return
        }
        var request = URLRequest(url: source)
        for (name, value) in call.getObject("headers") ?? [:] {
            if let value = value as? String { request.setValue(value, forHTTPHeaderField: name) }
        }
        let task = URLSession.shared.downloadTask(with: request) { temp, response, error in
            if let error = error as? URLError {
                call.reject("download: \(error.localizedDescription)", "unreachable"); return
            }
            if let error = error { call.reject("download: \(error.localizedDescription)"); return }
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                call.reject("download: the server answered HTTP \(http.statusCode)", "http_\(http.statusCode)"); return
            }
            guard let temp = temp else { call.reject("download: no file arrived"); return }
            do {
                try self.replace(target, with: temp)
                self.settle(target, path)
                let bytes = (try? self.files.attributesOfItem(atPath: target.path)[.size] as? Int) ?? 0
                call.resolve(["bytes": bytes])
            } catch {
                call.reject("download: \(error.localizedDescription)")
            }
        }
        task.resume()
    }
}
