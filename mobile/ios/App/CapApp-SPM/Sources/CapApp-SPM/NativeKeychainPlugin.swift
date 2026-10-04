import Foundation
import Capacitor
import Security

/// Small secrets the phone keeps for itself: the Crucible server list (with its
/// tokens) when the phone talks to Crucible directly. In the Keychain, never in
/// localStorage. Readable after the first unlock, so a job that finishes while
/// the phone is locked can still be fetched once the app runs again.
@objc(NativeKeychainPlugin)
public class NativeKeychainPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeKeychainPlugin"
    public let jsName = "NativeKeychain"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
    ]

    private let service = "com.owenmorgan.bside"

    private func query(_ key: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else { call.reject("get: needs a key"); return }
        var search = query(key)
        search[kSecReturnData as String] = true
        search[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: AnyObject?
        let status = SecItemCopyMatching(search as CFDictionary, &found)
        if status == errSecItemNotFound { call.resolve(["value": NSNull()]); return }
        guard status == errSecSuccess, let data = found as? Data, let value = String(data: data, encoding: .utf8) else {
            call.reject("get: the Keychain answered \(status)"); return
        }
        call.resolve(["value": value])
    }

    /// `value: null` removes the entry.
    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else { call.reject("set: needs a key"); return }
        SecItemDelete(query(key) as CFDictionary)
        guard let value = call.getString("value") else { call.resolve(); return }
        var item = query(key)
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { call.reject("set: the Keychain answered \(status)"); return }
        call.resolve()
    }
}
