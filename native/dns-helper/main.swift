import Darwin
import Foundation
import Network
import SystemConfiguration

private let helperVersion = 1
private let stateFile = "/var/root/Library/Application Support/Sparkle/dns-lease.json"
private let stateDirectory = "/var/root/Library/Application Support/Sparkle"
private let stateLockFile = "/var/root/Library/Application Support/Sparkle/dns-lease.lock"
private let installedHelperPath = "/Library/PrivilegedHelperTools/com.sparkle.SparkleDnsHelper"
private let launchDaemonPath = "/Library/LaunchDaemons/com.sparkle.SparkleDnsHelper.plist"
private let launchDaemonLabel = "com.sparkle.SparkleDnsHelper"
private let socketPath = "/var/run/sparkle-dns-helper.sock"
private let maximumRequestBytes = 64 * 1024

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
    error: String? = nil
) -> Status {
    Status(
        version: helperVersion,
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
}

private func readState() throws -> LeaseState? {
    guard FileManager.default.fileExists(atPath: stateFile) else { return nil }
    let data = try Data(contentsOf: URL(fileURLWithPath: stateFile))
    let state = try JSONDecoder().decode(LeaseState.self, from: data)
    guard state.version == helperVersion else {
        throw HelperError.unavailable("DNS helper 租约协议版本不兼容")
    }
    return state
}

private func writeState(_ state: LeaseState) throws {
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
    _ = fsync(descriptor)
    close(descriptor)
    guard writeResult, chmod(temporaryPath, mode_t(0o600)) == 0 else {
        try? FileManager.default.removeItem(atPath: temporaryPath)
        throw HelperError.transaction("无法保护 DNS helper 状态文件")
    }
    guard rename(temporaryPath, stateFile) == 0 else {
        try? FileManager.default.removeItem(atPath: temporaryPath)
        throw HelperError.transaction("无法原子保存 DNS helper 状态")
    }
    guard chmod(stateFile, mode_t(0o600)) == 0 else {
        throw HelperError.transaction("无法保护 DNS helper 状态文件")
    }
}

private func removeState() throws {
    if FileManager.default.fileExists(atPath: stateFile) {
        try FileManager.default.removeItem(atPath: stateFile)
    }
}

private final class NetworkContext {
    let preferences: SCPreferences
    let networkSet: SCNetworkSet

    init() throws {
        guard let preferences = SCPreferencesCreate(nil, "Sparkle DNS Helper" as CFString, nil),
              let networkSet = SCNetworkSetCopyCurrent(preferences) else {
            throw HelperError.unavailable("无法访问 macOS SystemConfiguration")
        }
        self.preferences = preferences
        self.networkSet = networkSet
    }

    func services() -> [SCNetworkService] {
        guard let services = SCNetworkSetCopyServices(networkSet) as? [SCNetworkService] else { return [] }
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

private func setConfiguration(
    _ context: NetworkContext,
    service: SCNetworkService,
    configuration: [String: Any]?,
    enabled: Bool
) throws {
    guard let proto = context.dnsProtocol(service) else {
        throw HelperError.unavailable("当前网络服务没有 DNS 协议")
    }
    guard SCPreferencesLock(context.preferences, true) else {
        throw HelperError.transaction("无法锁定 SystemConfiguration DNS 配置")
    }
    defer { _ = SCPreferencesUnlock(context.preferences) }
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

private func restoreState(_ state: LeaseState, stopWatch: Bool = true) throws {
    let context = try NetworkContext()
    guard let service = context.service(withID: state.serviceID) else {
        throw HelperError.conflict("原 DNS 网络服务已不存在，无法安全恢复")
    }
    let before = try snapshot(context, service: service)
    let original = try plistDictionary(state.originalConfiguration)
    guard owned(before, target: state.target) else {
        // A commit can fail before changing anything.  Treat an already
        // restored dictionary as an idempotent rollback, while refusing to
        // guess when the target fields are only partially changed.
        if restored(before, original: original) {
            if stopWatch { stopWatcher(state) }
            try removeState()
            return
        }
        throw HelperError.conflict("DNS 目标字段已被外部配置替换，未覆盖外部更改")
    }
    let merged = mergedConfiguration(current: before.configuration, original: original)
    // If an external actor disabled the protocol while our fields stayed
    // intact, preserve that explicit change instead of re-enabling it.
    let restoreEnabled = before.enabled ? state.protocolEnabled : false
    try setConfiguration(context, service: service, configuration: merged, enabled: restoreEnabled)
    let after = try snapshot(context, service: service)
    guard restored(after, original: original), after.enabled == restoreEnabled else {
        throw HelperError.transaction("DNS 恢复验证失败")
    }
    if stopWatch { stopWatcher(state) }
    try removeState()
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
        if let existing { try? restoreState(existing) }
        throw HelperError.unavailable("Mihomo DNS 监听器未通过 UDP 和 TCP DNS 探活")
    }
    if let existing {
        if existing.phase == "active", existing.target == target {
            let context = try NetworkContext()
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
        try restoreState(existing)
    }

    let context = try NetworkContext()
    let service = try context.primaryService()
    let before = try snapshot(context, service: service)
    guard before.protocolExists else { throw HelperError.unavailable("当前主网络服务没有 DNS 协议") }
    guard let original = try plistData(before.configuration) else {
        // A nil DNS configuration is valid and is represented by a nil plist.
        let state = LeaseState(version: helperVersion, phase: "pending", leaseID: UUID().uuidString,
                               target: target, serviceID: before.serviceID, protocolExists: true,
                               protocolEnabled: before.enabled, originalConfiguration: nil, watcherPID: nil)
        try writeState(state)
        return try applyNewLease(state, context: context, service: service, before: before)
    }
    let state = LeaseState(version: helperVersion, phase: "pending", leaseID: UUID().uuidString,
                           target: target, serviceID: before.serviceID, protocolExists: true,
                           protocolEnabled: before.enabled, originalConfiguration: original, watcherPID: nil)
    try writeState(state)
    return try applyNewLease(state, context: context, service: service, before: before)
}

private func applyNewLease(
    _ state: LeaseState,
    context: NetworkContext,
    service: SCNetworkService,
    before: Snapshot
) throws -> Status {
    var configuration = before.configuration ?? [:]
    configuration["ServerAddresses"] = [state.target.address]
    configuration["ServerPort"] = NSNumber(value: state.target.port)
    do {
        try setConfiguration(context, service: service, configuration: configuration, enabled: true)
        let after = try snapshot(context, service: service)
        guard owned(after, target: state.target) else { throw HelperError.transaction("DNS 应用验证失败") }
        var active = state
        active.phase = "active"
        try writeState(active)
        startWatchdog(&active)
        return status(state: active, active: true, healthy: true)
    } catch {
        do { try restoreState(state) } catch { throw HelperError.transaction("DNS 应用失败且回滚失败：\(error.localizedDescription)") }
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
    guard let service = context.service(withID: state.serviceID) else {
        return status(state: state, healthy: isHealthy, conflict: true, error: "DNS 网络服务已变化")
    }
    let current = try snapshot(context, service: service)
    guard owned(current, target: state.target) else {
        return status(state: state, healthy: isHealthy, conflict: true, error: "DNS 目标字段已被外部配置替换")
    }
    return status(state: state, active: state.phase == "active", healthy: isHealthy)
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
    let primary = try context.primaryService()
    guard let primaryID = context.serviceID(primary) else { throw HelperError.unavailable("主网络服务缺少标识") }
    if primaryID != state.serviceID {
        try restoreState(state)
        return try acquire(state.target)
    }
    let current = try snapshot(context, service: primary)
    guard owned(current, target: state.target) else {
        return status(state: state, healthy: true, conflict: true, error: "DNS 目标字段已被外部配置替换")
    }
    var refreshed = state
    stopWatcher(state)
    startWatchdog(&refreshed)
    try writeState(refreshed)
    return status(state: refreshed, active: true, healthy: true)
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
    var info = stat()
    guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
        throw HelperError.invalid("DNS helper 认证文件不存在或不是普通文件")
    }
    guard info.st_uid == uid, (info.st_mode & 0o077) == 0 else {
        throw HelperError.invalid("DNS helper 认证文件必须由应用用户拥有且仅用户可读")
    }
    let token = try String(contentsOfFile: path, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    guard token.count == 64, token.allSatisfy({ $0.isHexDigit }) else {
        throw HelperError.invalid("DNS helper 认证文件格式无效")
    }
    return path
}

private func plistEscape(_ value: String) -> String {
    value
        .replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
        .replacingOccurrences(of: "\"", with: "&quot;")
        .replacingOccurrences(of: "'", with: "&apos;")
}

private func validPackagedSource(_ path: String?) throws -> String {
    guard let path, path.hasPrefix("/"), URL(fileURLWithPath: path).lastPathComponent == "sparkle-dns-helper" else {
        throw HelperError.invalid("DNS helper 源文件路径无效")
    }
    let allowed = path.contains("/Contents/Resources/files/") || path.contains("/extra/files/")
    guard allowed else { throw HelperError.invalid("DNS helper 源文件不在 Sparkle 资源目录") }
    var info = stat()
    guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, (info.st_mode & S_IXUSR) != 0 else {
        throw HelperError.invalid("DNS helper 源文件不可执行")
    }
    return path
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

private func writeLaunchDaemonPlist(authFile: String, uid: uid_t) throws {
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
    <string>\(plistEscape(authFile))</string>
    <string>--uid</string>
    <string>\(uid)</string>
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
    try Data(xml.utf8).write(to: URL(fileURLWithPath: temporaryPath), options: [])
    guard chmod(temporaryPath, mode_t(0o644)) == 0, chown(temporaryPath, 0, 0) == 0 else {
        try? FileManager.default.removeItem(atPath: temporaryPath)
        throw HelperError.transaction("无法保护 DNS helper launchd 配置")
    }
    guard rename(temporaryPath, launchDaemonPath) == 0 else {
        try? FileManager.default.removeItem(atPath: temporaryPath)
        throw HelperError.transaction("无法原子安装 DNS helper launchd 配置")
    }
}

private func installDaemon(source: String?, authFile: String?, uidValue: String?) throws -> Status {
    try requireRoot()
    let sourcePath = try validPackagedSource(source)
    let uid = try validateUID(uidValue)
    let authPath = try validateAuthFile(authFile, uid: uid)

    do {
        // Stop the old daemon before replacing its root-owned executable.  Its
        // persisted lease remains in place; the new daemon reconciles it at boot.
        if daemonIsLoaded() {
            try runLaunchctl(["bootout", "system/\(launchDaemonLabel)"])
        }
        unlink(socketPath)

        let temporaryPath = installedHelperPath + ".tmp-" + UUID().uuidString
        try FileManager.default.copyItem(atPath: sourcePath, toPath: temporaryPath)
        guard chmod(temporaryPath, mode_t(0o755)) == 0, chown(temporaryPath, 0, 0) == 0 else {
            try? FileManager.default.removeItem(atPath: temporaryPath)
            throw HelperError.transaction("无法保护已安装的 DNS helper")
        }
        guard rename(temporaryPath, installedHelperPath) == 0 else {
            try? FileManager.default.removeItem(atPath: temporaryPath)
            throw HelperError.transaction("无法原子更新已安装的 DNS helper")
        }
        try writeLaunchDaemonPlist(authFile: authPath, uid: uid)
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
    try? FileManager.default.removeItem(atPath: launchDaemonPath)
    try? FileManager.default.removeItem(atPath: installedHelperPath)
    return status()
}

private func readAuth(_ path: String, uid: uid_t) throws -> String {
    _ = try validateAuthFile(path, uid: uid)
    return try String(contentsOfFile: path, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
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
    while data.count < maximumRequestBytes {
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

private func handleDaemonRequest(_ data: Data, auth: String) -> Status {
    do {
        let request = try JSONDecoder().decode(DaemonRequest.self, from: data)
        guard constantTimeEqual(request.auth, auth) else {
            return status(error: "DNS helper 请求认证失败")
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

private func daemon(_ authFile: String?, uidValue: String?) throws -> Never {
    try requireRoot()
    guard let authFile else { throw HelperError.invalid("daemon 缺少认证文件") }
    let uid = try validateUID(uidValue)
    let auth = try readAuth(authFile, uid: uid)
    let descriptor = try daemonSocket()
    guard chown(socketPath, uid, 0) == 0 else {
        close(descriptor)
        unlink(socketPath)
        throw HelperError.transaction("无法限制 DNS helper socket 所有者")
    }

    // Reconcile pending/active state before accepting app requests.  A reboot
    // therefore cannot leave a dead Mihomo listener as the default resolver.
    _ = try? withLeaseLock { try reconcile() }

    while true {
        var pollDescriptor = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
        let ready = poll(&pollDescriptor, 1, 5000)
        if ready == 0 {
            _ = try? withLeaseLock { try reconcile() }
            continue
        }
        guard ready > 0, pollDescriptor.revents & Int16(POLLIN) != 0 else { continue }
        let client = accept(descriptor, nil, nil)
        guard client >= 0 else { continue }
        if let data = readSocketLine(client) {
            let response = (try? withLeaseLock { handleDaemonRequest(data, auth: auth) }) ?? status(error: "DNS helper 租约锁定失败")
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
                uidValue: argument("--uid", in: arguments)
            )
        }
    case "uninstall":
        result = try withLeaseLock { try uninstallDaemon() }
    case "daemon":
        try daemon(argument("--auth-file", in: arguments), uidValue: argument("--uid", in: arguments))
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
