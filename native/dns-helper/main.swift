import Darwin
import Foundation
import Network
import CryptoKit
import SystemConfiguration

private let helperWireVersion = 1
private let leaseStateVersion = 1
private let stateFile = "/var/root/Library/Application Support/Sparkle/dns-lease.json"
private let stateDirectory = "/var/root/Library/Application Support/Sparkle"
private let stateLockFile = "/var/root/Library/Application Support/Sparkle/dns-lease.lock"
private let rootAuthFile = "/var/root/Library/Application Support/Sparkle/dns-helper-auth"
private let installedHelperPath = "/Library/PrivilegedHelperTools/com.sparkle.SparkleDnsHelper"
private let launchDaemonPath = "/Library/LaunchDaemons/com.sparkle.SparkleDnsHelper.plist"
private let launchDaemonLabel = "com.sparkle.SparkleDnsHelper"
private let socketPath = "/var/run/sparkle-dns-helper.sock"
private let maximumRequestBytes = 64 * 1024
private let maximumClientReadSeconds: Double = 5
private let maximumPreferencesLockAttempts = 20
private let preferencesLockRetryMicroseconds: useconds_t = 50_000

private var daemonBuildID: String?

private struct Target: Codable, Equatable {
    let listen: String
    let address: String
    let port: Int
}

private struct LeaseState: Codable {
    var version: Int
    var phase: String
    var leaseID: String
    var target: Target
    var serviceID: String
    var protocolExists: Bool
    var protocolEnabled: Bool
    var originalConfiguration: Data?
    var watcherPID: Int32?
}

private struct TargetStatus: Codable {
    let address: String
    let port: Int
}

private struct Status: Codable {
    var version: Int
    var build_id: String?
    var auth_failed: Bool?
    var supported: Bool
    var active: Bool
    var healthy: Bool
    var mode: String?
    var lease_id: String?
    var listen: String?
    var target: TargetStatus?
    var service_id: String?
    var conflict: Bool?
    var error: String?
}

private struct DaemonRequest: Codable {
    let auth: String
    let command: String
    let listen: String?
}

private struct Snapshot {
    let serviceID: String
    let protocolExists: Bool
    let enabled: Bool
    let configuration: [String: Any]?
    let addresses: [String]
    let port: Int?
}

private struct FileIdentity: Equatable {
    let device: UInt64
    let inode: UInt64
}

private enum HelperError: LocalizedError {
    case invalid(String)
    case unavailable(String)
    case conflict(String)
    case transaction(String)

    var errorDescription: String? {
        switch self {
        case .invalid(let value), .unavailable(let value), .conflict(let value), .transaction(let value):
            return value
        }
    }
}

private func withLeaseLock<T>(_ body: () throws -> T) throws -> T {
    try ensureStateDirectory()
    let descriptor = open(stateLockFile, O_CREAT | O_RDWR, mode_t(0o600))
    guard descriptor >= 0 else {
        throw HelperError.transaction("无法锁定 DNS helper 租约状态")
    }
    _ = fchmod(descriptor, mode_t(0o600))
    defer { close(descriptor) }
    guard flock(descriptor, LOCK_EX) == 0 else {
        throw HelperError.transaction("无法锁定 DNS helper 租约状态")
    }
    defer { _ = flock(descriptor, LOCK_UN) }
    return try body()
}

private func targetStatus(_ state: LeaseState) -> TargetStatus {
    TargetStatus(address: state.target.address, port: state.target.port)
}

private func status(
    state: LeaseState? = nil,
    active: Bool = false,
    healthy: Bool = false,
    conflict: Bool = false,
    authFailed: Bool = false,
    error: String? = nil
) -> Status {
    Status(
        version: helperWireVersion,
        build_id: daemonBuildID,
        auth_failed: authFailed ? true : nil,
        supported: true,
        active: active,
        healthy: healthy,
        mode: state == nil ? nil : "mihomo-listener",
        lease_id: state?.leaseID,
        listen: state?.target.listen,
        target: state.map(targetStatus),
        service_id: state?.serviceID,
        conflict: conflict ? true : nil,
        error: error
    )
}

private func writeJSON(_ value: some Encodable) {
    do {
        let data = try encodedJSON(value)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
        let fallback = "{\"version\":1,\"supported\":true,\"active\":false,\"healthy\":false,\"error\":\"状态编码失败\"}\n"
        FileHandle.standardOutput.write(Data(fallback.utf8))
    }
}

private func encodedJSON(_ value: some Encodable) throws -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return try encoder.encode(value)
}

private func parseTarget(_ value: String?) throws -> Target {
    guard let raw = value, !raw.isEmpty else {
        throw HelperError.invalid("dns.listen 不能为空")
    }
    let listen = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard listen == raw else { throw HelperError.invalid("dns.listen 首尾不能包含空格") }
    var address = ""
    var portText = ""
    if listen.hasPrefix("[") {
        guard let close = listen.firstIndex(of: "]"), listen.index(after: close) < listen.endIndex,
              listen[listen.index(after: close)] == ":" else {
            throw HelperError.invalid("IPv6 dns.listen 必须使用 [地址]:端口 格式")
        }
        address = String(listen[listen.index(after: listen.startIndex)..<close])
        portText = String(listen[listen.index(close, offsetBy: 2)..<listen.endIndex])
        guard address == "::1" else {
            throw HelperError.invalid("系统 DNS helper 只允许 ::1 回环地址")
        }
    } else {
        guard let separator = listen.lastIndex(of: ":"), separator > listen.startIndex,
              !listen[..<separator].contains(":") else {
            throw HelperError.invalid("dns.listen 必须是 127.0.0.1:端口 或 [::1]:端口")
        }
        address = String(listen[..<separator])
        portText = String(listen[listen.index(after: separator)..<listen.endIndex])
        guard address == "127.0.0.1" else {
            throw HelperError.invalid("系统 DNS helper 只允许 127.0.0.1 回环地址")
        }
    }
    guard let port = Int(portText), (1...65535).contains(port), port != 53 else {
        throw HelperError.invalid("系统 DNS helper 需要 1-65535 且非 53 端口")
    }
    return Target(listen: listen, address: address, port: port)
}

private func plistData(_ configuration: [String: Any]?) throws -> Data? {
    guard let configuration else { return nil }
    return try PropertyListSerialization.data(fromPropertyList: configuration, format: .binary, options: 0)
}

private func plistDictionary(_ data: Data?) throws -> [String: Any]? {
    guard let data else { return nil }
    let propertyList = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
    if let dictionary = propertyList as? [String: Any] { return dictionary }
    if let dictionary = propertyList as? NSDictionary { return dictionary as? [String: Any] }
    throw HelperError.transaction("保存的 DNS 配置不是有效字典")
}

private func ensureStateDirectory() throws {
    try FileManager.default.createDirectory(atPath: stateDirectory, withIntermediateDirectories: true)
    guard chmod(stateDirectory, mode_t(0o700)) == 0 else {
        throw HelperError.transaction("无法保护 DNS helper 状态目录")
    }
    var info = stat()
    guard lstat(stateDirectory, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR,
          info.st_uid == 0, (info.st_mode & 0o077) == 0 else {
        throw HelperError.transaction("DNS helper 状态目录权限不安全")
    }
}

private func syncDirectory(_ path: String) throws {
    let descriptor = open(path, O_RDONLY | O_DIRECTORY)
    guard descriptor >= 0 else {
        throw HelperError.transaction("无法持久化 DNS helper 目录")
    }
    defer { close(descriptor) }
    guard fsync(descriptor) == 0 else {
        throw HelperError.transaction("无法持久化 DNS helper 目录")
    }
}

private func readState() throws -> LeaseState? {
    guard FileManager.default.fileExists(atPath: stateFile) else { return nil }
    let data = try Data(contentsOf: URL(fileURLWithPath: stateFile))
    let state = try JSONDecoder().decode(LeaseState.self, from: data)
    guard state.version == leaseStateVersion else {
        throw HelperError.unavailable("DNS helper 租约协议版本不兼容")
    }
    return state
}

private func writeState(_ state: LeaseState) throws {
    // Durability invariant: the pending/active marker and root auth material
    // must reach stable storage before a DNS mutation can outlive recovery.
    try ensureStateDirectory()
    let data = try JSONEncoder().encode(state)
    let temporaryPath = stateFile + ".tmp-" + UUID().uuidString
    let descriptor = open(temporaryPath, O_CREAT | O_EXCL | O_WRONLY, mode_t(0o600))
    guard descriptor >= 0 else { throw HelperError.transaction("无法创建 DNS helper 状态文件") }
    let writeResult = data.withUnsafeBytes { rawBuffer -> Bool in
        guard let baseAddress = rawBuffer.baseAddress else { return true }
        var written = 0
        while written < rawBuffer.count {
            let count = write(descriptor, baseAddress.advanced(by: written), rawBuffer.count - written)
            if count <= 0 { return false }
            written += count
        }
        return true
    }
    let permissionResult = fchmod(descriptor, mode_t(0o600)) == 0
    let syncResult = fsync(descriptor)
    close(descriptor)
    guard writeResult, permissionResult, syncResult == 0 else {
        try? FileManager.default.removeItem(atPath: temporaryPath)
        throw HelperError.transaction("无法保护 DNS helper 状态文件")
    }
    guard rename(temporaryPath, stateFile) == 0 else {
        try? FileManager.default.removeItem(atPath: temporaryPath)
        throw HelperError.transaction("无法原子保存 DNS helper 状态")
    }
    try syncDirectory(stateDirectory)
}

private func removeState() throws {
    if FileManager.default.fileExists(atPath: stateFile) {
        try FileManager.default.removeItem(atPath: stateFile)
        try syncDirectory(stateDirectory)
    }
}

private final class NetworkContext {
    let preferences: SCPreferences

    init() throws {
        guard let preferences = SCPreferencesCreate(nil, "Sparkle DNS Helper" as CFString, nil) else {
            throw HelperError.unavailable("无法访问 macOS SystemConfiguration")
        }
        self.preferences = preferences
    }

    func services() -> [SCNetworkService] {
        guard let networkSet = SCNetworkSetCopyCurrent(preferences),
              let services = SCNetworkSetCopyServices(networkSet) as? [SCNetworkService] else { return [] }
        return services
    }

    func serviceID(_ service: SCNetworkService) -> String? {
        SCNetworkServiceGetServiceID(service) as String?
    }

    func service(withID id: String) -> SCNetworkService? {
        services().first { serviceID($0) == id }
    }

    func primaryService() throws -> SCNetworkService {
        let store = SCDynamicStoreCreate(nil, "Sparkle DNS Helper" as CFString, nil, nil)
        for key in ["State:/Network/Global/IPv4", "State:/Network/Global/IPv6"] {
            let value = store.flatMap { SCDynamicStoreCopyValue($0, key as CFString) }
            let dictionary = (value as? NSDictionary) as? [String: Any]
            let primaryID = dictionary?["PrimaryService"] as? String
            if let primaryID, let service = service(withID: primaryID) { return service }
        }

        throw HelperError.unavailable("找不到 macOS 当前主网络服务")
    }

    func dnsProtocol(_ service: SCNetworkService) -> SCNetworkProtocol? {
        SCNetworkServiceCopyProtocol(service, kSCNetworkProtocolTypeDNS)
    }
}

/**
 * SCPreferencesLock(..., false) is deliberately used with bounded retries.
 * Every read/check/merge/write/commit transaction gets a fresh view after the
 * lock, so an external writer cannot race a stale snapshot into our commit.
 */
private func withPreferencesLock<T>(_ context: NetworkContext, _ body: () throws -> T) throws -> T {
    var locked = false
    for _ in 0..<maximumPreferencesLockAttempts {
        if SCPreferencesLock(context.preferences, false) {
            locked = true
            break
        }
        usleep(preferencesLockRetryMicroseconds)
    }
    guard locked else {
        throw HelperError.transaction("无法在限定时间内锁定 SystemConfiguration DNS 配置")
    }
    defer { _ = SCPreferencesUnlock(context.preferences) }
    SCPreferencesSynchronize(context.preferences)
    return try body()
}

private func configuration(_ proto: SCNetworkProtocol) -> [String: Any]? {
    guard let value = SCNetworkProtocolGetConfiguration(proto) else { return nil }
    if let value = value as? [String: Any] { return value }
    return (value as NSDictionary) as? [String: Any]
}

private func snapshot(_ context: NetworkContext, service: SCNetworkService) throws -> Snapshot {
    guard let serviceID = context.serviceID(service) else {
        throw HelperError.unavailable("网络服务缺少稳定标识")
    }
    guard let proto = context.dnsProtocol(service) else {
        return Snapshot(serviceID: serviceID, protocolExists: false, enabled: false, configuration: nil, addresses: [], port: nil)
    }
    let config = configuration(proto)
    let addresses: [String]
    if let values = config?["ServerAddresses"] as? [String] {
        addresses = values
    } else if let values = config?["ServerAddresses"] as? NSArray {
        addresses = values.compactMap { $0 as? String }
    } else {
        addresses = []
    }
    let port = (config?["ServerPort"] as? NSNumber)?.intValue
    return Snapshot(
        serviceID: serviceID,
        protocolExists: true,
        enabled: SCNetworkProtocolGetEnabled(proto),
        configuration: config,
        addresses: addresses,
        port: port
    )
}

private func setConfigurationLocked(
    _ context: NetworkContext,
    service: SCNetworkService,
    configuration: [String: Any]?,
    enabled: Bool
) throws {
    guard let proto = context.dnsProtocol(service) else {
        throw HelperError.unavailable("当前网络服务没有 DNS 协议")
    }
    let configured: Bool
    if let configuration {
        configured = SCNetworkProtocolSetConfiguration(proto, configuration as NSDictionary)
    } else {
        configured = SCNetworkProtocolSetConfiguration(proto, nil)
    }
    guard configured, SCNetworkProtocolSetEnabled(proto, enabled) else {
        throw HelperError.transaction("SystemConfiguration DNS 配置失败")
    }
    guard SCPreferencesCommitChanges(context.preferences), SCPreferencesApplyChanges(context.preferences) else {
        throw HelperError.transaction("SystemConfiguration DNS 提交失败")
    }
}

private func mergedConfiguration(
    current: [String: Any]?,
    original: [String: Any]?
) -> [String: Any]? {
    var merged = current ?? [:]
    if let original, let value = original["ServerAddresses"] {
        merged["ServerAddresses"] = value
    } else {
        merged.removeValue(forKey: "ServerAddresses")
    }
    if let original, let value = original["ServerPort"] {
        merged["ServerPort"] = value
    } else {
        merged.removeValue(forKey: "ServerPort")
    }
    return merged.isEmpty ? nil : merged
}

private func owned(_ snapshot: Snapshot, target: Target) -> Bool {
    snapshot.protocolExists && snapshot.addresses == [target.address] && snapshot.port == target.port
}

private func restored(_ snapshot: Snapshot, original: [String: Any]?) -> Bool {
    let originalAddresses: [String]
    if let values = original?["ServerAddresses"] as? [String] {
        originalAddresses = values
    } else if let values = original?["ServerAddresses"] as? NSArray {
        originalAddresses = values.compactMap { $0 as? String }
    } else {
        originalAddresses = []
    }
    let originalPort = (original?["ServerPort"] as? NSNumber)?.intValue
    return snapshot.addresses == originalAddresses && snapshot.port == originalPort
}

private func stopWatcher(_ state: LeaseState, keepCurrentProcess: Bool = false) {
    guard let pid = state.watcherPID, !keepCurrentProcess, pid != getpid() else { return }
    _ = kill(pid, SIGTERM)
}

private func restoreStateLocked(
    _ context: NetworkContext,
    state: LeaseState,
    stopWatch: Bool = true
) throws {
    // Re-resolve the service after the preferences lock. The object used for
    // the compare, merge, commit, and verify is therefore from one coherent
    // SystemConfiguration transaction.
    guard let service = context.service(withID: state.serviceID) else {
        throw HelperError.conflict("原 DNS 网络服务已不存在，无法安全恢复")
    }
    let before = try snapshot(context, service: service)
    let original = try plistDictionary(state.originalConfiguration)
    let fieldsOwned = owned(before, target: state.target)
    let fieldsRestored = restored(before, original: original)
    // If an external actor disabled the protocol while our fields stayed
    // intact, preserve that explicit change instead of re-enabling it.
    let restoreEnabled = before.enabled ? state.protocolEnabled : false
    if !fieldsOwned {
        // A commit can fail before changing anything. Treat an already
        // restored dictionary as an idempotent rollback, but still undo a
        // helper-owned protocol-enable transition when the fields happen to
        // match the original snapshot already.
        guard fieldsRestored else {
            throw HelperError.conflict("DNS 目标字段已被外部配置替换，未覆盖外部更改")
        }
        if before.enabled != restoreEnabled {
            try setConfigurationLocked(context, service: service, configuration: before.configuration, enabled: restoreEnabled)
            guard let verifiedService = context.service(withID: state.serviceID) else {
                throw HelperError.conflict("恢复后 DNS 网络服务已不存在")
            }
            let after = try snapshot(context, service: verifiedService)
            guard restored(after, original: original), after.enabled == restoreEnabled else {
                throw HelperError.transaction("DNS 恢复验证失败")
            }
        }
        if stopWatch { stopWatcher(state) }
        try removeState()
        return
    }
    let merged = mergedConfiguration(current: before.configuration, original: original)
    try setConfigurationLocked(context, service: service, configuration: merged, enabled: restoreEnabled)
    guard let verifiedService = context.service(withID: state.serviceID) else {
        throw HelperError.conflict("恢复后 DNS 网络服务已不存在")
    }
    let after = try snapshot(context, service: verifiedService)
    guard restored(after, original: original), after.enabled == restoreEnabled else {
        throw HelperError.transaction("DNS 恢复验证失败")
    }
    if stopWatch { stopWatcher(state) }
    try removeState()
}

private func restoreState(_ state: LeaseState, stopWatch: Bool = true) throws {
    let context = try NetworkContext()
    try withPreferencesLock(context) {
        try restoreStateLocked(context, state: state, stopWatch: stopWatch)
    }
}

private func dnsQuery(_ target: Target, tcp: Bool) -> Bool {
    guard let port = NWEndpoint.Port(rawValue: UInt16(target.port)) else { return false }
    let connection = NWConnection(
        host: NWEndpoint.Host(target.address),
        port: port,
        using: tcp ? .tcp : .udp
    )
    let query = Data([0x53, 0x50, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                      0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x03, 0x63, 0x6f, 0x6d,
                      0x00, 0x00, 0x01, 0x00, 0x01])
    let payload: Data
    if tcp {
        payload = Data([UInt8(query.count >> 8), UInt8(query.count & 0xff)]) + query
    } else {
        payload = query
    }
    let semaphore = DispatchSemaphore(value: 0)
    var result = false
    var finished = false
    let finish: (Bool) -> Void = { value in
        guard !finished else { return }
        finished = true
        result = value
        semaphore.signal()
    }

    func validate(_ data: Data?) -> Bool {
        guard let data, data.count >= 4 else { return false }
        return data[data.startIndex] == 0x53 && data[data.startIndex + 1] == 0x50 &&
            data[data.startIndex + 2] & 0x80 != 0
    }

    connection.stateUpdateHandler = { state in
        switch state {
        case .ready:
            connection.send(content: payload, completion: .contentProcessed { error in
                guard error == nil else { finish(false); return }
                if tcp {
                    connection.receive(minimumIncompleteLength: 2, maximumLength: 2) { length, _, _, error in
                        guard error == nil, let length, length.count == 2 else { finish(false); return }
                        let size = Int(length[0]) << 8 | Int(length[1])
                        guard size > 3, size <= 65535 else { finish(false); return }
                        connection.receive(minimumIncompleteLength: size, maximumLength: size) { data, _, _, error in
                            finish(error == nil && validate(data))
                        }
                    }
                } else {
                    connection.receive(minimumIncompleteLength: 4, maximumLength: 4096) { data, _, _, error in
                        finish(error == nil && validate(data))
                    }
                }
            })
        case .failed, .cancelled:
            finish(false)
        default:
            break
        }
    }
    connection.start(queue: DispatchQueue.global(qos: .utility))
    if semaphore.wait(timeout: .now() + 2.0) == .timedOut { connection.cancel(); return false }
    connection.cancel()
    return result
}

private func healthy(_ target: Target) -> Bool {
    dnsQuery(target, tcp: false) && dnsQuery(target, tcp: true)
}

private func startWatchdog(_ state: inout LeaseState) {
    // Health and network-change monitoring belongs to the single launchd
    // daemon.  Never fork one watchdog per acquire/reconcile operation.
    state.watcherPID = nil
}

private func acquire(_ target: Target) throws -> Status {
    let existing = try readState()
    guard healthy(target) else {
        if let existing {
            do {
                try restoreState(existing)
            } catch {
                throw HelperError.transaction("新 DNS 目标不健康且旧租约恢复失败：\(error.localizedDescription)")
            }
        }
        throw HelperError.unavailable("Mihomo DNS 监听器未通过 UDP 和 TCP DNS 探活")
    }
    if let existing {
        if existing.phase == "active", existing.target == target {
            let context = try NetworkContext()
            return try withPreferencesLock(context) {
                guard let service = context.service(withID: existing.serviceID) else {
                    throw HelperError.conflict("DNS 网络服务已变化，请先恢复旧租约")
                }
                let current = try snapshot(context, service: service)
                guard owned(current, target: target) else {
                    throw HelperError.conflict("DNS 目标字段已被外部配置替换")
                }
                var refreshed = existing
                stopWatcher(existing)
                startWatchdog(&refreshed)
                try writeState(refreshed)
                return status(state: refreshed, active: true, healthy: true)
            }
        }
        try restoreState(existing)
    }

    let context = try NetworkContext()
    return try withPreferencesLock(context) {
        let service = try context.primaryService()
        let before = try snapshot(context, service: service)
        guard before.protocolExists else { throw HelperError.unavailable("当前主网络服务没有 DNS 协议") }
        let original = try plistData(before.configuration)
        // The pending record is durable before the first SystemConfiguration
        // mutation. A crash at any point can therefore be reconciled safely.
        let state = LeaseState(version: leaseStateVersion, phase: "pending", leaseID: UUID().uuidString,
                               target: target, serviceID: before.serviceID, protocolExists: true,
                               protocolEnabled: before.enabled, originalConfiguration: original, watcherPID: nil)
        try writeState(state)
        return try applyNewLeaseLocked(state, context: context)
    }
}

private func applyNewLeaseLocked(
    _ state: LeaseState,
    context: NetworkContext
) throws -> Status {
    guard let service = context.service(withID: state.serviceID) else {
        throw HelperError.conflict("应用 DNS 租约时网络服务已不存在")
    }
    let before = try snapshot(context, service: service)
    guard before.protocolExists else { throw HelperError.unavailable("当前网络服务没有 DNS 协议") }
    var configuration = before.configuration ?? [:]
    configuration["ServerAddresses"] = [state.target.address]
    configuration["ServerPort"] = NSNumber(value: state.target.port)
    do {
        try setConfigurationLocked(context, service: service, configuration: configuration, enabled: true)
        guard let verifiedService = context.service(withID: state.serviceID) else {
            throw HelperError.conflict("应用 DNS 租约后网络服务已不存在")
        }
        let after = try snapshot(context, service: verifiedService)
        guard owned(after, target: state.target) else { throw HelperError.transaction("DNS 应用验证失败") }
        // A successful SCPreferences commit is not sufficient: the final
        // runtime listener must answer real UDP and TCP DNS exchanges after
        // the resolver target is changed. Roll back while still holding the
        // same preferences lock if this post-apply check fails.
        guard healthy(state.target) else {
            throw HelperError.unavailable("DNS 应用后 Mihomo 监听器未通过 UDP 和 TCP DNS 探活")
        }
        var active = state
        active.phase = "active"
        try writeState(active)
        startWatchdog(&active)
        return status(state: active, active: true, healthy: true)
    } catch {
        do {
            try restoreStateLocked(context, state: state)
        } catch {
            throw HelperError.transaction("DNS 应用失败且回滚失败：\(error.localizedDescription)")
        }
        throw error
    }
}

private func release() throws -> Status {
    guard let state = try readState() else { return status() }
    do {
        try restoreState(state)
        return status(active: false, healthy: false)
    } catch let error as HelperError {
        if case .conflict(let message) = error { return status(state: state, conflict: true, error: message) }
        throw error
    }
}

private func currentStatus() throws -> Status {
    guard let state = try readState() else { return status() }
    let isHealthy = healthy(state.target)
    let context = try NetworkContext()
    return try withPreferencesLock(context) {
        guard let service = context.service(withID: state.serviceID) else {
            return status(state: state, healthy: isHealthy, conflict: true, error: "DNS 网络服务已变化")
        }
        let current = try snapshot(context, service: service)
        guard owned(current, target: state.target) else {
            return status(state: state, healthy: isHealthy, conflict: true, error: "DNS 目标字段已被外部配置替换")
        }
        return status(state: state, active: state.phase == "active", healthy: isHealthy)
    }
}

private func reconcile() throws -> Status {
    guard let state = try readState() else { return status() }
    if state.phase == "pending" {
        return try release()
    }
    guard healthy(state.target) else {
        return try release()
    }
    let context = try NetworkContext()
    let serviceChanged = try withPreferencesLock(context) { () -> Bool in
        let primary = try context.primaryService()
        guard let primaryID = context.serviceID(primary) else {
            throw HelperError.unavailable("主网络服务缺少标识")
        }
        if primaryID != state.serviceID {
            try restoreStateLocked(context, state: state)
            return true
        }
        let current = try snapshot(context, service: primary)
        guard owned(current, target: state.target) else {
            return false
        }
        var refreshed = state
        stopWatcher(state)
        startWatchdog(&refreshed)
        try writeState(refreshed)
        return false
    }
    if serviceChanged {
        return try acquire(state.target)
    }
    // Re-read under the lock after the possible refresh to produce a truthful
    // conflict status without using stale SC objects.
    let contextAfter = try NetworkContext()
    return try withPreferencesLock(contextAfter) {
        guard let refreshedState = try readState(),
              let service = contextAfter.service(withID: refreshedState.serviceID) else {
            return status()
        }
        let current = try snapshot(contextAfter, service: service)
        guard owned(current, target: refreshedState.target) else {
            return status(state: refreshedState, healthy: true, conflict: true, error: "DNS 目标字段已被外部配置替换")
        }
        return status(state: refreshedState, active: refreshedState.phase == "active", healthy: true)
    }
}

private func requireRoot() throws {
    guard getuid() == 0 else {
        throw HelperError.unavailable("DNS helper 管理操作需要 root 权限")
    }
}

private func validateUID(_ value: String?) throws -> uid_t {
    guard let value, let parsed = UInt32(value), parsed > 0 else {
        throw HelperError.invalid("缺少有效的应用用户 UID")
    }
    return uid_t(parsed)
}

private func validateAuthFile(_ path: String?, uid: uid_t) throws -> String {
    guard let path, path.hasPrefix("/"), path.hasSuffix("/dns-helper-auth") else {
        throw HelperError.invalid("DNS helper 认证文件路径无效")
    }
    _ = try readValidatedAuthFile(path, owner: uid)
    return path
}

private func readValidatedAuthFile(_ path: String, owner: uid_t) throws -> String {
    let descriptor = open(path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw HelperError.invalid("DNS helper 认证文件不存在或不可打开") }
    defer { close(descriptor) }
    var info = stat()
    guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
          info.st_uid == owner, (info.st_mode & 0o077) == 0 else {
        throw HelperError.invalid("DNS helper 认证文件必须由指定用户拥有且仅用户可读")
    }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 256)
    while true {
        let count = buffer.withUnsafeMutableBytes { rawBuffer -> Int in
            guard let baseAddress = rawBuffer.baseAddress else { return -1 }
            return read(descriptor, baseAddress, rawBuffer.count)
        }
        if count < 0 { throw HelperError.invalid("读取 DNS helper 认证文件失败") }
        if count == 0 { break }
        data.append(contentsOf: buffer.prefix(count))
        if data.count > 256 { throw HelperError.invalid("DNS helper 认证文件过大") }
    }
    guard let token = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) else {
        throw HelperError.invalid("DNS helper 认证文件格式无效")
    }
    guard token.count == 64, token.allSatisfy({ $0.isHexDigit }) else {
        throw HelperError.invalid("DNS helper 认证文件格式无效")
    }
    return token
}

private func writePrivateDataAtomically(_ data: Data, path: String, mode: mode_t, owner: uid_t, group: gid_t) throws {
    let temporaryPath = path + ".tmp-" + UUID().uuidString
    let descriptor = open(temporaryPath, O_CREAT | O_EXCL | O_WRONLY, mode)
    guard descriptor >= 0 else { throw HelperError.transaction("无法创建 DNS helper 私有文件") }
    let writeResult = data.withUnsafeBytes { rawBuffer -> Bool in
        guard let baseAddress = rawBuffer.baseAddress else { return true }
        var written = 0
        while written < rawBuffer.count {
            let count = write(descriptor, baseAddress.advanced(by: written), rawBuffer.count - written)
            if count <= 0 { return false }
            written += count
        }
        return true
    }
    let permissionResult = fchmod(descriptor, mode) == 0 && fchown(descriptor, owner, group) == 0
    let syncResult = fsync(descriptor)
    close(descriptor)
    guard writeResult, permissionResult, syncResult == 0 else {
        try? FileManager.default.removeItem(atPath: temporaryPath)
        throw HelperError.transaction("无法保护 DNS helper 私有文件")
    }
    guard rename(temporaryPath, path) == 0 else {
        try? FileManager.default.removeItem(atPath: temporaryPath)
        throw HelperError.transaction("无法原子保存 DNS helper 私有文件")
    }
    try syncDirectory(URL(fileURLWithPath: path).deletingLastPathComponent().path)
}

private func writeRootAuthAtomically(_ token: String) throws {
    guard token.count == 64, token.allSatisfy({ $0.isHexDigit }) else {
        throw HelperError.invalid("DNS helper 认证文件格式无效")
    }
    try ensureStateDirectory()
    try writePrivateDataAtomically(
        Data((token + "\n").utf8),
        path: rootAuthFile,
        mode: mode_t(0o600),
        owner: 0,
        group: 0
    )
}

private func readRootAuth() throws -> String {
    do {
        return try readValidatedAuthFile(rootAuthFile, owner: 0)
    } catch {
        throw HelperError.unavailable("DNS helper root 认证材料不存在或权限不安全")
    }
}

private func plistEscape(_ value: String) -> String {
    value
        .replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
        .replacingOccurrences(of: "\"", with: "&quot;")
        .replacingOccurrences(of: "'", with: "&apos;")
}

private func canonicalPath(_ path: String) throws -> String {
    try path.withCString { value in
        guard let resolved = realpath(value, nil) else {
            throw HelperError.invalid("DNS helper 路径无法解析")
        }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}

private func currentExecutablePath() throws -> String {
    // _NSGetExecutablePath is provided by Darwin and cannot be redirected by
    // an argv[0] lookalike supplied to the privileged installer.
    var size: UInt32 = 4096
    while size <= 1024 * 1024 {
        var buffer = [Int8](repeating: 0, count: Int(size))
        let result = buffer.withUnsafeMutableBufferPointer { pointer in
            _NSGetExecutablePath(pointer.baseAddress!, &size)
        }
        if result == 0 {
            return try canonicalPath(String(cString: buffer))
        }
        size = max(size * 2, size + 1)
    }
    throw HelperError.invalid("DNS helper 当前可执行文件路径过长")
}

private func fileIdentity(_ descriptor: Int32) throws -> FileIdentity {
    var info = stat()
    guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
        throw HelperError.invalid("DNS helper 当前可执行文件不可验证")
    }
    return FileIdentity(device: UInt64(info.st_dev), inode: UInt64(info.st_ino))
}

private func pathIdentity(_ path: String) throws -> FileIdentity {
    let descriptor = open(path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw HelperError.invalid("DNS helper 当前可执行文件不可打开") }
    defer { close(descriptor) }
    return try fileIdentity(descriptor)
}

private func validateSourcePermissions(_ path: String, uid: uid_t, packaged: Bool) throws {
    var cursor = URL(fileURLWithPath: path)
    while true {
        var info = stat()
        guard lstat(cursor.path, &info) == 0 else {
            throw HelperError.invalid("DNS helper 源路径无法验证")
        }
        guard (info.st_mode & 0o022) == 0, (info.st_uid == 0 || info.st_uid == uid) else {
            throw HelperError.invalid("DNS helper 源路径权限不安全")
        }
        if cursor.path != path {
            guard (info.st_mode & S_IFMT) == S_IFDIR else {
                throw HelperError.invalid("DNS helper 源路径包含非目录组件")
            }
        }
        if packaged && cursor.lastPathComponent.hasSuffix(".app") { break }
        let parent = cursor.deletingLastPathComponent()
        if parent.path == cursor.path { break }
        cursor = parent
    }
}

private func validPackagedSource(_ path: String?, executablePath: String, uid: uid_t) throws -> String {
    guard let path, path.hasPrefix("/"),
          URL(fileURLWithPath: path).lastPathComponent == "sparkle-dns-helper",
          URL(fileURLWithPath: path).standardizedFileURL.path == path,
          !path.contains("/../") else {
        throw HelperError.invalid("DNS helper 源文件路径无效")
    }
    let canonical = try canonicalPath(path)
    guard canonical == executablePath else {
        throw HelperError.invalid("DNS helper 源文件必须是当前运行的 Sparkle helper")
    }
    let components = URL(fileURLWithPath: path).pathComponents
    let packagedSuffix = ["Contents", "Resources", "files", "sparkle-dns-helper"]
    let developmentSuffix = ["extra", "files", "sparkle-dns-helper"]
    let packaged = components.suffix(packagedSuffix.count).elementsEqual(packagedSuffix)
    let allowed = packaged || components.suffix(developmentSuffix.count).elementsEqual(developmentSuffix)
    guard allowed else { throw HelperError.invalid("DNS helper 源文件不在 Sparkle 资源目录") }
    var info = stat()
    guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, (info.st_mode & S_IXUSR) != 0 else {
        throw HelperError.invalid("DNS helper 源文件不可执行")
    }
    try validateSourcePermissions(path, uid: uid, packaged: packaged)
    return path
}

private func validateBuildID(_ value: String?) throws -> String {
    guard let value, value.count == 64, value.allSatisfy({ $0.isHexDigit }) else {
        throw HelperError.invalid("DNS helper 构建标识无效")
    }
    return value.lowercased()
}

private func readPackagedExecutable(
    _ path: String,
    expectedBuildID: String,
    expectedIdentity: FileIdentity
) throws -> Data {
    let descriptor = open(path, O_RDONLY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw HelperError.invalid("无法打开 DNS helper 打包源文件") }
    defer { close(descriptor) }
    let identity = try fileIdentity(descriptor)
    var info = stat()
    guard identity == expectedIdentity, fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
          (info.st_mode & S_IXUSR) != 0 else {
        throw HelperError.invalid("DNS helper 打包源文件不可执行")
    }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while true {
        let count = buffer.withUnsafeMutableBytes { rawBuffer -> Int in
            guard let baseAddress = rawBuffer.baseAddress else { return -1 }
            return read(descriptor, baseAddress, rawBuffer.count)
        }
        if count < 0 { throw HelperError.invalid("读取 DNS helper 打包源文件失败") }
        if count == 0 { break }
        data.append(contentsOf: buffer.prefix(count))
        if data.count > 128 * 1024 * 1024 {
            throw HelperError.invalid("DNS helper 打包源文件过大")
        }
    }
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    guard digest == expectedBuildID.lowercased() else {
        throw HelperError.invalid("DNS helper 打包源文件校验失败")
    }
    return data
}

private func runLaunchctl(_ arguments: [String], allowFailure: Bool = false) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = arguments
    let output = Pipe()
    process.standardError = output
    process.standardOutput = output
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 || allowFailure else {
        let detail = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        throw HelperError.transaction("launchd 操作失败：\(detail.trimmingCharacters(in: .whitespacesAndNewlines))")
    }
}

private func daemonIsLoaded() -> Bool {
    do {
        try runLaunchctl(["print", "system/\(launchDaemonLabel)"])
        return true
    } catch {
        return false
    }
}

private func stopDaemonBeforeReplacement() throws {
    // Bootout is intentionally attempted even when launchctl's prior print
    // raced a just-starting daemon. Never rotate root auth while an old
    // process could still be serving the socket.
    try runLaunchctl(["bootout", "system/\(launchDaemonLabel)"], allowFailure: true)
    for _ in 0..<20 {
        if !daemonIsLoaded() { return }
        usleep(preferencesLockRetryMicroseconds)
    }
    throw HelperError.transaction("旧 DNS helper 未能在更新前停止")
}

private func writeLaunchDaemonPlist(uid: uid_t, buildID: String) throws {
    let xml = """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
    <key>Label</key>
    <string>\(launchDaemonLabel)</string>
    <key>ProgramArguments</key>
    <array>
    <string>\(installedHelperPath)</string>
    <string>daemon</string>
    <string>--auth-file</string>
    <string>\(plistEscape(rootAuthFile))</string>
    <string>--uid</string>
    <string>\(uid)</string>
    <string>--build-id</string>
    <string>\(plistEscape(buildID))</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>ProcessType</key>
    <string>Background</string>
    </dict>
    </plist>
    """
    let temporaryPath = launchDaemonPath + ".tmp-" + UUID().uuidString
    try writePrivateDataAtomically(
        Data(xml.utf8),
        path: temporaryPath,
        mode: mode_t(0o644),
        owner: 0,
        group: 0
    )
    guard rename(temporaryPath, launchDaemonPath) == 0 else {
        try? FileManager.default.removeItem(atPath: temporaryPath)
        throw HelperError.transaction("无法原子安装 DNS helper launchd 配置")
    }
    try syncDirectory(URL(fileURLWithPath: launchDaemonPath).deletingLastPathComponent().path)
}

private func installDaemon(source: String?, authFile: String?, uidValue: String?, buildID: String?) throws -> Status {
    try requireRoot()
    let uid = try validateUID(uidValue)
    let executablePath = try currentExecutablePath()
    let executableIdentity = try pathIdentity(executablePath)
    let sourcePath = try validPackagedSource(source, executablePath: executablePath, uid: uid)
    let authPath = try validateAuthFile(authFile, uid: uid)
    let expectedBuildID = try validateBuildID(buildID)
    // Open, fstat, copy, and hash one exact descriptor. This avoids the old
    // path-reopen TOCTOU and rejects a swapped lookalike source.
    let sourceData = try readPackagedExecutable(
        sourcePath,
        expectedBuildID: expectedBuildID,
        expectedIdentity: executableIdentity
    )
    let token = try readValidatedAuthFile(authPath, owner: uid)
    try ensureStateDirectory()

    do {
        // Stop the old daemon before replacing its root-owned executable.  Its
        // persisted lease remains in place; the new daemon reconciles it at boot.
        try stopDaemonBeforeReplacement()
        unlink(socketPath)
        // Rotate root auth only after the old process has stopped. The daemon
        // reads this file for each request, so a failed install can recover
        // without leaving a live process on an obsolete credential.
        try writeRootAuthAtomically(token)

        let temporaryPath = installedHelperPath + ".tmp-" + UUID().uuidString
        try writePrivateDataAtomically(sourceData, path: temporaryPath, mode: mode_t(0o755), owner: 0, group: 0)
        guard rename(temporaryPath, installedHelperPath) == 0 else {
            try? FileManager.default.removeItem(atPath: temporaryPath)
            throw HelperError.transaction("无法原子更新已安装的 DNS helper")
        }
        try syncDirectory(URL(fileURLWithPath: installedHelperPath).deletingLastPathComponent().path)
        try writeLaunchDaemonPlist(uid: uid, buildID: expectedBuildID)
        daemonBuildID = expectedBuildID
        try runLaunchctl(["bootstrap", "system", launchDaemonPath])
        try runLaunchctl(["kickstart", "-k", "system/\(launchDaemonLabel)"], allowFailure: true)
        return status()
    } catch {
        // Keep a persisted lease recoverable even if an installer/launchd
        // operation fails midway.  The bootstrap is best-effort because the
        // original error remains the actionable result for the app.
        try? runLaunchctl(["bootstrap", "system", launchDaemonPath], allowFailure: true)
        throw error
    }
}

private func uninstallDaemon() throws -> Status {
    try requireRoot()
    // Never remove the daemon while a lease still points at the listener.
    if let state = try readState() {
        try restoreState(state)
    }
    if daemonIsLoaded() {
        try runLaunchctl(["bootout", "system/\(launchDaemonLabel)"])
    }
    unlink(socketPath)
    if FileManager.default.fileExists(atPath: launchDaemonPath) {
        try FileManager.default.removeItem(atPath: launchDaemonPath)
    }
    if FileManager.default.fileExists(atPath: installedHelperPath) {
        try FileManager.default.removeItem(atPath: installedHelperPath)
    }
    if FileManager.default.fileExists(atPath: rootAuthFile) {
        try FileManager.default.removeItem(atPath: rootAuthFile)
    }
    return status()
}

private func constantTimeEqual(_ left: String, _ right: String) -> Bool {
    let lhs = Array(left.utf8)
    let rhs = Array(right.utf8)
    guard lhs.count == rhs.count else { return false }
    var difference: UInt8 = 0
    for index in lhs.indices { difference |= lhs[index] ^ rhs[index] }
    return difference == 0
}

private func readSocketLine(_ descriptor: Int32) -> Data? {
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(maximumClientReadSeconds * 1_000_000_000)
    while data.count < maximumRequestBytes {
        let now = DispatchTime.now().uptimeNanoseconds
        if now >= deadline { return nil }
        let remainingMilliseconds = Int32((deadline - now) / 1_000_000)
        var pollDescriptor = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
        let ready = poll(&pollDescriptor, 1, max(1, remainingMilliseconds))
        if ready <= 0 || pollDescriptor.revents & Int16(POLLIN) == 0 { return nil }
        let count = read(descriptor, &buffer, buffer.count)
        if count <= 0 { break }
        data.append(contentsOf: buffer.prefix(count))
        if buffer.prefix(count).contains(10) { break }
    }
    guard let newline = data.firstIndex(of: 10), newline <= maximumRequestBytes else { return nil }
    return data.prefix(upTo: newline)
}

private func writeSocketJSON(_ value: some Encodable, to descriptor: Int32) {
    guard let data = try? encodedJSON(value) else { return }
    var response = data
    response.append(10)
    response.withUnsafeBytes { rawBuffer in
        guard let baseAddress = rawBuffer.baseAddress else { return }
        var written = 0
        while written < rawBuffer.count {
            let count = write(descriptor, baseAddress.advanced(by: written), rawBuffer.count - written)
            if count <= 0 { break }
            written += count
        }
    }
}

private func handleDaemonRequest(_ data: Data) -> Status {
    do {
        let request = try JSONDecoder().decode(DaemonRequest.self, from: data)
        guard let currentAuth = try? readRootAuth() else {
            return status(authFailed: true, error: "DNS helper root 认证材料不可用")
        }
        guard constantTimeEqual(request.auth, currentAuth) else {
            return status(authFailed: true, error: "DNS helper 请求认证失败")
        }
        switch request.command {
        case "acquire":
            return try acquire(parseTarget(request.listen))
        case "release":
            return try release()
        case "status":
            return try currentStatus()
        case "reconcile":
            return try reconcile()
        default:
            return status(error: "DNS helper 不支持此操作")
        }
    } catch let error as HelperError {
        switch error {
        case .conflict(let message): return status(conflict: true, error: message)
        default: return status(error: error.localizedDescription)
        }
    } catch {
        return status(error: error.localizedDescription)
    }
}

private func daemonSocket() throws -> Int32 {
    unlink(socketPath)
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw HelperError.transaction("无法创建 DNS helper 本地 socket") }
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let pathBytes = Array(socketPath.utf8) + [0]
    guard pathBytes.count <= MemoryLayout.size(ofValue: address.sun_path) else {
        close(descriptor)
        throw HelperError.transaction("DNS helper socket 路径过长")
    }
    withUnsafeMutableBytes(of: &address.sun_path) { rawBuffer in
        rawBuffer.copyBytes(from: pathBytes)
    }
    let addressLength = socklen_t(MemoryLayout<sockaddr_un>.size)
    let bound = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(descriptor, $0, addressLength) }
    }
    guard bound == 0, listen(descriptor, 8) == 0 else {
        close(descriptor)
        throw HelperError.transaction("无法启动 DNS helper 本地 socket")
    }
    guard chmod(socketPath, mode_t(0o600)) == 0 else {
        close(descriptor)
        unlink(socketPath)
        throw HelperError.transaction("无法保护 DNS helper 本地 socket")
    }
    return descriptor
}

private func daemonReconcile() {
    do {
        _ = try withLeaseLock { try reconcile() }
    } catch {
        let message = "Sparkle DNS helper reconcile failed: \(error.localizedDescription)\n"
        FileHandle.standardError.write(Data(message.utf8))
    }
}

private func daemon(_ authFile: String?, uidValue: String?, buildID: String?) throws -> Never {
    try requireRoot()
    guard authFile == rootAuthFile else { throw HelperError.invalid("daemon 认证材料必须来自 root 私有路径") }
    let uid = try validateUID(uidValue)
    daemonBuildID = try validateBuildID(buildID)
    let descriptor = try daemonSocket()
    guard chown(socketPath, uid, 0) == 0 else {
        close(descriptor)
        unlink(socketPath)
        throw HelperError.transaction("无法限制 DNS helper socket 所有者")
    }

    // Reconcile pending/active state before accepting app requests.  A reboot
    // therefore cannot leave a dead Mihomo listener as the default resolver.
    daemonReconcile()

    while true {
        var pollDescriptor = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
        let ready = poll(&pollDescriptor, 1, 5000)
        if ready == 0 {
            daemonReconcile()
            continue
        }
        guard ready > 0, pollDescriptor.revents & Int16(POLLIN) != 0 else { continue }
        let client = accept(descriptor, nil, nil)
        guard client >= 0 else { continue }
        if let data = readSocketLine(client) {
            let response = (try? withLeaseLock { handleDaemonRequest(data) }) ?? status(error: "DNS helper 租约锁定失败")
            writeSocketJSON(response, to: client)
        }
        close(client)
    }
}

private func argument(_ name: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.index(after: index) < arguments.endIndex else { return nil }
    return arguments[arguments.index(after: index)]
}

let arguments = Array(CommandLine.arguments.dropFirst())
let command = arguments.first ?? ""
do {
    let result: Status
    switch command {
    case "acquire":
        result = try withLeaseLock { try acquire(parseTarget(argument("--listen", in: arguments))) }
    case "release":
        result = try withLeaseLock { try release() }
    case "status":
        result = try withLeaseLock { try currentStatus() }
    case "reconcile":
        result = try withLeaseLock { try reconcile() }
    case "install":
        result = try withLeaseLock {
            try installDaemon(
                source: argument("--source", in: arguments),
                authFile: argument("--auth-file", in: arguments),
                uidValue: argument("--uid", in: arguments),
                buildID: argument("--build-id", in: arguments)
            )
        }
    case "uninstall":
        result = try withLeaseLock { try uninstallDaemon() }
    case "daemon":
        try daemon(
            argument("--auth-file", in: arguments),
            uidValue: argument("--uid", in: arguments),
            buildID: argument("--build-id", in: arguments)
        )
    default:
        throw HelperError.invalid("仅支持 install、uninstall、daemon、acquire、release、status、reconcile")
    }
    writeJSON(result)
} catch let error as HelperError {
    switch error {
    case .conflict(let message): writeJSON(status(conflict: true, error: message))
    default: writeJSON(status(error: error.localizedDescription))
    }
} catch {
    writeJSON(status(error: error.localizedDescription))
}
