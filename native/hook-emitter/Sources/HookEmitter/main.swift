import Darwin
import Dispatch
import Foundation
import HookProtocol

private let maximumDescriptorBytes = 4096
private let maximumFrameBytes = 8192
private let maximumSpoolBytes = 262_144
private let maximumSpoolSessions = 32

private func monotonicNanoseconds() -> UInt64? {
    var time = timespec()
    guard clock_gettime(CLOCK_MONOTONIC, &time) == 0,
        time.tv_sec >= 0, time.tv_nsec >= 0
    else { return nil }
    let (seconds, secondsOverflow) = UInt64(time.tv_sec).multipliedReportingOverflow(by: 1_000_000_000)
    let (result, resultOverflow) = seconds.addingReportingOverflow(UInt64(time.tv_nsec))
    return secondsOverflow || resultOverflow ? nil : result
}

private struct Deadline {
    private let end: UInt64

    init?() {
        guard let start = monotonicNanoseconds() else { return nil }
        let (end, overflow) = start.addingReportingOverflow(150_000_000)
        guard !overflow else { return nil }
        self.end = end
    }

    var isActive: Bool {
        guard let now = monotonicNanoseconds() else { return false }
        return now < end
    }

    var pollMilliseconds: Int32? {
        guard let now = monotonicNanoseconds(), now < end else { return nil }
        // Round down: a sub-millisecond remainder uses a nonblocking poll.
        return Int32((end - now) / 1_000_000)
    }
}

private func waitUntilReady(_ fd: Int32, events: Int16, deadline: Deadline) -> Bool {
    while let milliseconds = deadline.pollMilliseconds {
        var entry = pollfd(fd: fd, events: events, revents: 0)
        let result = Darwin.poll(&entry, 1, milliseconds)
        if result > 0 {
            guard deadline.isActive, entry.revents & Int16(POLLNVAL) == 0 else { return false }
            return entry.revents & (events | Int16(POLLHUP) | Int16(POLLERR)) != 0
        }
        if result < 0 && errno != EINTR { return false }
    }
    return false
}

// The caller supplies a nonblocking FD and retains ownership of it.
private func readBounded(_ fd: Int32, limit: Int, deadline: Deadline) -> Data? {
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: min(limit + 1, 16_384))
    while deadline.isActive {
        let request = min(buffer.count, limit + 1 - data.count)
        let count = buffer.withUnsafeMutableBytes { storage in
            Darwin.read(fd, storage.baseAddress, request)
        }
        if count > 0 {
            guard count <= limit - data.count else { return nil }
            data.append(contentsOf: buffer.prefix(count))
        } else if count == 0 {
            return deadline.isActive ? data : nil
        } else if errno == EAGAIN || errno == EWOULDBLOCK {
            guard waitUntilReady(fd, events: Int16(POLLIN), deadline: deadline) else { return nil }
        } else if errno != EINTR {
            return nil
        }
    }
    return nil
}

private func readStandardInput(deadline: Deadline) -> Data? {
    guard deadline.isActive else { return nil }
    let flags = Darwin.fcntl(STDIN_FILENO, F_GETFL)
    guard flags >= 0,
        Darwin.fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK) == 0
    else { return nil }
    defer { _ = Darwin.fcntl(STDIN_FILENO, F_SETFL, flags) }
    return readBounded(STDIN_FILENO, limit: EventProjection.maximumInputBytes, deadline: deadline)
}

private struct AbsolutePath {
    let full: String
    let parent: String
    let name: String

    init?(_ path: String) {
        guard path.hasPrefix("/"), !path.utf8.contains(0),
            let separator = path.lastIndex(of: "/")
        else { return nil }
        let name = String(path[path.index(after: separator)...])
        guard !name.isEmpty, name != ".", name != ".." else { return nil }
        full = path
        parent = separator == path.startIndex ? "/" : String(path[..<separator])
        self.name = name
    }
}

private func isUUID(_ value: String, lowercaseOnly: Bool) -> Bool {
    guard value.utf8.count == 36 else { return false }
    for (index, byte) in value.utf8.enumerated() {
        if index == 8 || index == 13 || index == 18 || index == 23 {
            if byte != 45 { return false }
        } else if !((48...57).contains(byte) || (97...102).contains(byte)
            || (!lowercaseOnly && (65...70).contains(byte)))
        {
            return false
        }
    }
    return true
}

private func isToken(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy {
        (48...57).contains($0) || (97...102).contains($0)
    }
}

private func hasPrivateMetadata(
    _ metadata: stat, kind: mode_t, permissions: mode_t, uid: uid_t
) -> Bool {
    metadata.st_uid == uid && metadata.st_mode & mode_t(S_IFMT) == kind
        && metadata.st_mode & mode_t(0o7777) == permissions
}

private func openPrivateDirectory(
    _ path: String, in base: Int32 = AT_FDCWD, uid: uid_t, deadline: Deadline
) -> Int32? {
    guard deadline.isActive else { return nil }
    let fd = path.withCString {
        Darwin.openat(base, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
    }
    guard fd >= 0 else { return nil }
    var metadata = stat()
    guard deadline.isActive, Darwin.fstat(fd, &metadata) == 0,
        hasPrivateMetadata(metadata, kind: mode_t(S_IFDIR), permissions: 0o700, uid: uid),
        deadline.isActive
    else {
        Darwin.close(fd)
        return nil
    }
    return fd
}

private enum DescriptorError: Error {
    case invalid
}

private struct AnyKey: CodingKey {
    let stringValue: String
    var intValue: Int? { nil }

    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

private struct Descriptor: Decodable {
    let epoch: String
    let token: String
    let socketPath: String

    private enum CodingKeys: String, CodingKey {
        case version
        case epoch
        case token
        case socketPath
    }

    init(from decoder: Decoder) throws {
        let allValues = try decoder.container(keyedBy: AnyKey.self)
        guard Set(allValues.allKeys.map(\.stringValue)) == Set(["version", "epoch", "token", "socketPath"]) else {
            throw DescriptorError.invalid
        }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        guard try values.decode(Int.self, forKey: .version) == 1 else { throw DescriptorError.invalid }
        epoch = try values.decode(String.self, forKey: .epoch)
        token = try values.decode(String.self, forKey: .token)
        socketPath = try values.decode(String.self, forKey: .socketPath)
        guard isUUID(epoch, lowercaseOnly: true), isToken(token), AbsolutePath(socketPath) != nil else {
            throw DescriptorError.invalid
        }
    }
}

private enum DescriptorState {
    case absent
    case invalid
    case found(Descriptor)
}

private func readDescriptor(_ path: AbsolutePath, uid: uid_t, deadline: Deadline) -> DescriptorState {
    guard let directory = openPrivateDirectory(path.parent, uid: uid, deadline: deadline) else { return .invalid }
    defer { Darwin.close(directory) }
    guard deadline.isActive else { return .invalid }
    var openError: Int32 = 0
    let fd = path.name.withCString {
        let fd = Darwin.openat(directory, $0, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        openError = errno
        return fd
    }
    guard fd >= 0 else { return openError == ENOENT ? .absent : .invalid }
    defer { Darwin.close(fd) }
    var metadata = stat()
    guard deadline.isActive, Darwin.fstat(fd, &metadata) == 0,
        hasPrivateMetadata(metadata, kind: mode_t(S_IFREG), permissions: 0o600, uid: uid),
        metadata.st_size > 0, metadata.st_size <= off_t(maximumDescriptorBytes),
        let bytes = readBounded(fd, limit: maximumDescriptorBytes, deadline: deadline),
        deadline.isActive,
        let descriptor = try? JSONDecoder().decode(Descriptor.self, from: bytes),
        deadline.isActive
    else { return .invalid }
    return .found(descriptor)
}

private struct Frame: Encodable {
    let version = 1
    let epoch: String
    let token: String
    // Transport identity for one emission, not a provider operation or turn ID.
    let eventId = UUID().uuidString.lowercased()
    let event: ClaudeEvent
}

// Returns 0 once connected, otherwise the errno that stopped the attempt.
private func connectOnce(_ fd: Int32, address: inout sockaddr_un, deadline: Deadline) -> Int32 {
    guard deadline.isActive else { return ETIMEDOUT }
    let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    if result != 0 {
        let error = errno
        guard error == EINPROGRESS || error == EINTR else { return error }
        guard waitUntilReady(fd, events: Int16(POLLOUT), deadline: deadline) else { return ETIMEDOUT }
        var socketError: Int32 = 0
        var length = socklen_t(MemoryLayout<Int32>.size)
        guard Darwin.getsockopt(fd, SOL_SOCKET, SO_ERROR, &socketError, &length) == 0 else { return errno }
        guard socketError == 0 else { return socketError }
    }
    return deadline.isActive ? 0 : ETIMEDOUT
}

private func sendAll(_ bytes: Data, fd: Int32, deadline: Deadline) -> Bool {
    bytes.withUnsafeBytes { storage in
        guard let base = storage.baseAddress else { return false }
        var offset = 0
        while offset < storage.count && deadline.isActive {
            let count = Darwin.send(fd, base.advanced(by: offset), storage.count - offset, 0)
            if count > 0 {
                offset += count
            } else if count == 0 {
                return false
            } else if errno == EAGAIN || errno == EWOULDBLOCK {
                guard waitUntilReady(fd, events: Int16(POLLOUT), deadline: deadline) else { return false }
            } else if errno != EINTR {
                return false
            }
        }
        return offset == storage.count && deadline.isActive
    }
}

private enum Emission {
    case sent
    // Nothing listens at the endpoint, so the app is not running.
    case offline
    case failed
}

private func emit(
    _ event: ClaudeEvent, descriptor: Descriptor, uid: uid_t, deadline: Deadline
) -> Emission {
    #if WATCHLING_NATIVE_TRACE
    diagnosticTrace.record(.connectBegin)
    var connected = false
    defer {
        if !connected {
            diagnosticTrace.record(.connectEnd)
            diagnosticTrace.reject(.connectBegin)
        }
    }
    #endif
    guard deadline.isActive,
        let path = AbsolutePath(descriptor.socketPath),
        var frame = try? JSONEncoder().encode(
            Frame(epoch: descriptor.epoch, token: descriptor.token, event: event)
        ),
        frame.count < maximumFrameBytes, deadline.isActive
    else { return .failed }
    frame.append(0x0A)

    var address = sockaddr_un()
    guard path.full.utf8.count < MemoryLayout.size(ofValue: address.sun_path) else { return .failed }
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    withUnsafeMutableBytes(of: &address.sun_path) { storage in
        storage.copyBytes(from: path.full.utf8)
    }

    guard let directory = openPrivateDirectory(path.parent, uid: uid, deadline: deadline) else {
        let missing = path.parent.withCString { Darwin.access($0, F_OK) != 0 && errno == ENOENT }
        return missing ? .offline : .failed
    }
    defer { Darwin.close(directory) }
    var metadata = stat()
    var inspectError: Int32 = 0
    let inspected = path.name.withCString {
        let result = Darwin.fstatat(directory, $0, &metadata, AT_SYMLINK_NOFOLLOW)
        inspectError = errno
        return result
    }
    guard inspected == 0 else { return inspectError == ENOENT ? .offline : .failed }
    guard hasPrivateMetadata(metadata, kind: mode_t(S_IFSOCK), permissions: 0o600, uid: uid),
        deadline.isActive
    else { return .failed }

    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return .failed }
    defer { Darwin.close(fd) }
    let flags = Darwin.fcntl(fd, F_GETFL)
    guard flags >= 0, Darwin.fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0,
        Darwin.fcntl(fd, F_SETFD, FD_CLOEXEC) == 0, deadline.isActive
    else { return .failed }
    var noSigpipe: Int32 = 1
    guard Darwin.setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, socklen_t(MemoryLayout<Int32>.size)) == 0
    else { return .failed }
    let connectError = connectOnce(fd, address: &address, deadline: deadline)
    guard connectError == 0 else {
        // A running app can refuse connections when its backlog is full, so only a missing socket counts.
        return connectError == ENOENT ? .offline : .failed
    }

    var peerUid: uid_t = 0
    var peerGid: gid_t = 0
    guard Darwin.getpeereid(fd, &peerUid, &peerGid) == 0, peerUid == uid, deadline.isActive else { return .failed }
    #if WATCHLING_NATIVE_TRACE
    connected = true
    diagnosticTrace.record(.connectEnd)
    diagnosticTrace.record(.sendBegin)
    #endif
    let sent = sendAll(frame, fd: fd, deadline: deadline)
    #if WATCHLING_NATIVE_TRACE
    diagnosticTrace.record(.sendEnd)
    if !sent { diagnosticTrace.reject(.sendBegin) }
    #endif
    return sent ? .sent : .failed
}

private func markEnvironment(_ event: inout ClaudeEvent, deadline: Deadline) {
    let environment = ProcessInfo.processInfo.environment
    TerminalLocation.mark(&event, environment: environment)
    guard event.eventName == "PermissionRequest" || event.eventName == "Notification" else { return }
    event.interactive = ProcessAncestry.interactivity(
        environment: environment, start: Darwin.getppid(),
        table: DarwinProcessTable(), isActive: { deadline.isActive }
    )
}

private struct SpoolRecord: Encodable {
    let pid: Int32
    let startedAt: Int
    let event: ClaudeEvent
}

private func openPendingDirectory(_ descriptorPath: AbsolutePath, uid: uid_t, deadline: Deadline) -> Int32? {
    guard let parent = openPrivateDirectory(descriptorPath.parent, uid: uid, deadline: deadline) else { return nil }
    defer { Darwin.close(parent) }
    // The app may claim the directory between creating and opening it, so try once more.
    for _ in 0..<2 {
        let created = "pending".withCString { Darwin.mkdirat(parent, $0, 0o700) == 0 || errno == EEXIST }
        guard created else { return nil }
        if let pending = openPrivateDirectory("pending", in: parent, uid: uid, deadline: deadline) {
            return pending
        }
    }
    return nil
}

private func spooledSessions(in directory: Int32, deadline: Deadline) -> Int? {
    let fd = ".".withCString { Darwin.openat(directory, $0, O_RDONLY | O_DIRECTORY | O_CLOEXEC) }
    guard fd >= 0 else { return nil }
    guard let stream = Darwin.fdopendir(fd) else {
        Darwin.close(fd)
        return nil
    }
    defer { Darwin.closedir(stream) }
    var count = 0
    while deadline.isActive, let entry = Darwin.readdir(stream) {
        let name = withUnsafeBytes(of: entry.pointee.d_name) {
            String(decoding: $0.prefix(Int(entry.pointee.d_namlen)), as: UTF8.self)
        }
        if name.hasSuffix(".jsonl") { count += 1 }
    }
    return deadline.isActive ? count : nil
}

private func spool(_ record: SpoolRecord, in directory: Int32, uid: uid_t, deadline: Deadline) {
    let name = record.event.sessionId + ".jsonl"
    if record.event.eventName == "SessionEnd" && record.event.agentId == nil {
        _ = name.withCString { Darwin.unlinkat(directory, $0, 0) }
        return
    }
    guard var line = try? JSONEncoder().encode(record), line.count < maximumFrameBytes, deadline.isActive
    else { return }
    line.append(0x0A)
    let open = { (flags: Int32) -> (Int32, Int32) in
        name.withCString {
            let fd = Darwin.openat(directory, $0, O_WRONLY | O_APPEND | O_NOFOLLOW | O_CLOEXEC | flags, 0o600)
            return (fd, errno)
        }
    }
    var (fd, openError) = open(0)
    if fd < 0 && openError == ENOENT,
        let count = spooledSessions(in: directory, deadline: deadline), count < maximumSpoolSessions
    {
        (fd, _) = open(O_CREAT)
    }
    guard fd >= 0 else { return }
    defer { Darwin.close(fd) }
    var metadata = stat()
    guard Darwin.fstat(fd, &metadata) == 0,
        hasPrivateMetadata(metadata, kind: mode_t(S_IFREG), permissions: 0o600, uid: uid),
        deadline.isActive
    else { return }
    if Int(metadata.st_size) + line.count > maximumSpoolBytes {
        // The app shows a session whose record restarted as unknown until its next prompt.
        guard Darwin.ftruncate(fd, 0) == 0 else { return }
        line = Data("{\"lost\":true}\n".utf8) + line
    }
    _ = line.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
}

// Keeps the event for the app's next launch. The app publishes its endpoint before it
// claims the pending directory, so the endpoint is checked again after opening it.
private func spoolOffline(_ bytes: Data, descriptorPath: AbsolutePath, uid: uid_t, deadline: Deadline) {
    guard var event = EventProjection.project(bytes), isUUID(event.sessionId, lowercaseOnly: true),
        deadline.isActive,
        let pending = openPendingDirectory(descriptorPath, uid: uid, deadline: deadline)
    else { return }
    defer { Darwin.close(pending) }
    switch readDescriptor(descriptorPath, uid: uid, deadline: deadline) {
    case .invalid:
        return
    case .found(let descriptor):
        guard var live = EventProjection.project(
            bytes, fingerprintKey: InputFingerprint.key(token: descriptor.token)
        ), deadline.isActive else { return }
        markEnvironment(&live, deadline: deadline)
        guard emit(live, descriptor: descriptor, uid: uid, deadline: deadline) == .offline else { return }
    case .absent:
        break
    }
    markEnvironment(&event, deadline: deadline)
    let table = DarwinProcessTable()
    guard let pid = ProcessAncestry.claudeProcess(
        environment: ProcessInfo.processInfo.environment, start: Darwin.getppid(),
        table: table, isActive: { deadline.isActive }
    ), let startedAt = table.startTime(of: pid), deadline.isActive else { return }
    spool(SpoolRecord(pid: pid, startedAt: startedAt, event: event), in: pending, uid: uid, deadline: deadline)
}

private func run(deadline: Deadline) {
    let arguments = CommandLine.arguments
    guard arguments.count == 5, arguments[1] == "--installation-id",
        isUUID(arguments[2], lowercaseOnly: false), arguments[3] == "--descriptor",
        let descriptorPath = AbsolutePath(arguments[4]), deadline.isActive
    else {
        #if WATCHLING_NATIVE_TRACE
        diagnosticTrace.reject(.mainEntry)
        #endif
        return
    }

    // The installation ID is only a validated ownership marker, never authorization.
    let uid = Darwin.getuid()
    guard uid == Darwin.geteuid() else {
        #if WATCHLING_NATIVE_TRACE
        diagnosticTrace.reject(.mainEntry)
        #endif
        return
    }

    #if WATCHLING_NATIVE_TRACE
    diagnosticTrace.record(.stdinBegin)
    #endif
    guard let bytes = readStandardInput(deadline: deadline), deadline.isActive else {
        #if WATCHLING_NATIVE_TRACE
        diagnosticTrace.record(.stdinEnd)
        diagnosticTrace.reject(.stdinBegin)
        #endif
        return
    }
    #if WATCHLING_NATIVE_TRACE
    diagnosticTrace.record(.stdinEnd)
    diagnosticTrace.record(.descriptorBegin)
    #endif
    let state = readDescriptor(descriptorPath, uid: uid, deadline: deadline)
    guard case .found(let descriptor) = state else {
        #if WATCHLING_NATIVE_TRACE
        diagnosticTrace.record(.descriptorEnd)
        diagnosticTrace.reject(.descriptorBegin)
        #endif
        if case .absent = state { spoolOffline(bytes, descriptorPath: descriptorPath, uid: uid, deadline: deadline) }
        return
    }
    #if WATCHLING_NATIVE_TRACE
    diagnosticTrace.record(.descriptorEnd)
    diagnosticTrace.record(.projectionBegin)
    #endif
    guard var event = EventProjection.project(
        bytes, fingerprintKey: InputFingerprint.key(token: descriptor.token)
    ), deadline.isActive else {
        #if WATCHLING_NATIVE_TRACE
        diagnosticTrace.record(.projectionEnd)
        diagnosticTrace.reject(.projectionBegin)
        #endif
        return
    }
    #if WATCHLING_NATIVE_TRACE
    diagnosticTrace.record(.projectionEnd)
    #endif
    markEnvironment(&event, deadline: deadline)
    if emit(event, descriptor: descriptor, uid: uid, deadline: deadline) == .offline {
        spoolOffline(bytes, descriptorPath: descriptorPath, uid: uid, deadline: deadline)
    }
}

let watchdogDeadline = DispatchTime.now() + .milliseconds(150)
#if WATCHLING_NATIVE_TRACE
private let diagnosticTrace = DiagnosticTrace()
diagnosticTrace.record(.mainEntry)
#endif
if let deadline = Deadline() {
    // A separate queue can terminate even while the main thread is blocked in filesystem I/O.
    DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: watchdogDeadline) {
        #if WATCHLING_NATIVE_TRACE
        diagnosticTrace.record(.watchdogExit)
        #endif
        Darwin._exit(0)
    }
    run(deadline: deadline)
} else {
    #if WATCHLING_NATIVE_TRACE
    diagnosticTrace.reject(.mainEntry)
    #endif
}
#if WATCHLING_NATIVE_TRACE
diagnosticTrace.record(.normalReturn)
#endif
Darwin._exit(0)
