import Foundation
import Capacitor

/// B-Side's files on the phone: the songs of playlists kept for offline
/// listening, and one small state file (which playlists, and the last library).
///
/// Songs are DOWNLOADED straight to disk by URLSession — never passed through
/// the bridge as base64 (Bookshelf learned that a large file base64'd into one
/// string out-of-memory-reloads the WebView). AVPlayer opens the resulting
/// file:// URL; it reads the format from the extension, so names keep theirs.
/// Everything lives in Documents/bside-offline and is kept out of backups.
@objc(NativeFilePlugin)
public class NativeFilePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeFilePlugin"
    public let jsName = "NativeFile"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "download", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeText", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readText", returnType: CAPPluginReturnPromise),
    ]

    private func storageDir() throws -> URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("bside-offline", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    /// A bare file name: nothing that could climb out of the folder.
    private func checked(_ name: String?) -> String? {
        guard let name = name, !name.isEmpty, !name.contains("/"), !name.hasPrefix(".") else { return nil }
        return name
    }

    private func excludeFromBackup(_ url: URL) {
        var mutable = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? mutable.setResourceValues(values)
    }

    @objc func download(_ call: CAPPluginCall) {
        guard let s = call.getString("url"), let source = URL(string: s), let name = checked(call.getString("name")) else {
            call.reject("download: needs a url and a bare file name"); return
        }
        let task = URLSession.shared.downloadTask(with: source) { temp, response, error in
            if let error = error { call.reject("download: \(error.localizedDescription)"); return }
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                call.reject("download: the hub answered HTTP \(http.statusCode)"); return
            }
            guard let temp = temp else { call.reject("download: no file arrived"); return }
            do {
                let target = try self.storageDir().appendingPathComponent(name)
                // Into place in one move: a half-downloaded song never sits under its real name.
                if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
                try FileManager.default.moveItem(at: temp, to: target)
                self.excludeFromBackup(target)
                let bytes = (try? FileManager.default.attributesOfItem(atPath: target.path)[.size] as? Int) ?? 0
                call.resolve(["url": target.absoluteString, "bytes": bytes])
            } catch {
                call.reject("download: \(error.localizedDescription)")
            }
        }
        task.resume()
    }

    @objc func list(_ call: CAPPluginCall) {
        do {
            let dir = try storageDir()
            let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
            let files: [[String: Any]] = names.map { name in
                let url = dir.appendingPathComponent(name)
                let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
                return ["name": name, "url": url.absoluteString, "bytes": bytes]
            }
            call.resolve(["files": files])
        } catch {
            // A failed listing must THROW in JS: an empty answer would read as "nothing saved".
            call.reject("list: \(error.localizedDescription)")
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let name = checked(call.getString("name")) else { call.reject("remove: needs a bare file name"); return }
        do {
            let url = try storageDir().appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            call.resolve()
        } catch {
            call.reject("remove: \(error.localizedDescription)")
        }
    }

    @objc func writeText(_ call: CAPPluginCall) {
        guard let name = checked(call.getString("name")), let text = call.getString("text") else {
            call.reject("writeText: needs a bare file name and text"); return
        }
        do {
            let url = try storageDir().appendingPathComponent(name)
            try text.data(using: .utf8)!.write(to: url, options: .atomic)
            excludeFromBackup(url)
            call.resolve()
        } catch {
            call.reject("writeText: \(error.localizedDescription)")
        }
    }

    @objc func readText(_ call: CAPPluginCall) {
        guard let name = checked(call.getString("name")) else { call.reject("readText: needs a bare file name"); return }
        do {
            let url = try storageDir().appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path) else { call.resolve(["text": NSNull()]); return }
            call.resolve(["text": try String(contentsOf: url, encoding: .utf8)])
        } catch {
            call.reject("readText: \(error.localizedDescription)")
        }
    }
}
