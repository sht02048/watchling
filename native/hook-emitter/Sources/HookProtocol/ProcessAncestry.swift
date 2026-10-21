import Darwin

public protocol ProcessTable {
    func parent(of pid: Int32) -> Int32?
    func arguments(of pid: Int32) -> [String]?
    func executablePath(of pid: Int32) -> String?
}

public enum ProcessAncestry {
    public static func interactivity(
        environment: [String: String], start: Int32, table: ProcessTable,
        limit: Int = 4, isActive: () -> Bool
    ) -> Bool? {
        switch environment["CLAUDE_CODE_SESSION_ATTENDED"] {
        case "1": return true
        case "0": return false
        default: break
        }
        var claudePid: Int32?
        if let value = environment["CLAUDE_PID"] {
            guard let pid = Int32(value), pid > 1 else { return nil }
            claudePid = pid
        }
        var pid = start
        var visited: Set<Int32> = []
        for _ in 0..<limit {
            guard isActive(), pid > 1, visited.insert(pid).inserted else { return nil }
            let isClaude = claudePid.map { $0 == pid } ?? recognizesClaude(pid, table: table)
            if isClaude {
                guard let arguments = table.arguments(of: pid), isActive() else { return nil }
                return !arguments.dropFirst().contains {
                    $0 == "-p" || $0 == "--print" || $0.hasPrefix("--print=")
                }
            }
            guard let parent = table.parent(of: pid) else { return nil }
            pid = parent
        }
        return nil
    }

    private static func basename(_ path: String) -> Substring {
        path.split(separator: "/", omittingEmptySubsequences: false).last ?? ""
    }

    private static func recognizesClaude(_ pid: Int32, table: ProcessTable) -> Bool {
        let arguments = table.arguments(of: pid)
        let path = table.executablePath(of: pid)
        if let first = arguments?.first, basename(first) == "claude" { return true }
        if let path, path.contains("/claude/versions/") { return true }
        let isNode = [arguments?.first, path].contains { $0.map { basename($0) == "node" } ?? false }
        return isNode && (arguments?.contains { $0.contains("@anthropic-ai/claude-code/") } ?? false)
    }
}

public struct DarwinProcessTable: ProcessTable {
    public init() {}

    public func parent(of pid: Int32) -> Int32? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return Int32(bitPattern: info.pbi_ppid)
    }

    public func arguments(of pid: Int32) -> [String]? {
        var argumentMax: Int32 = 0
        var length = MemoryLayout<Int32>.size
        var query: [Int32] = [CTL_KERN, KERN_ARGMAX]
        guard sysctl(&query, 2, &argumentMax, &length, nil, 0) == 0, argumentMax > 0 else { return nil }
        var buffer = [UInt8](repeating: 0, count: Int(argumentMax))
        var size = buffer.count
        var request: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        guard sysctl(&request, 3, &buffer, &size, nil, 0) == 0,
            size >= MemoryLayout<Int32>.size
        else { return nil }
        let count = buffer.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
        guard count >= 0 else { return nil }
        var index = MemoryLayout<Int32>.size
        while index < size && buffer[index] != 0 { index += 1 }
        while index < size && buffer[index] == 0 { index += 1 }
        var arguments: [String] = []
        while arguments.count < Int(count) {
            guard index < size else { return nil }
            let start = index
            while index < size && buffer[index] != 0 { index += 1 }
            guard index < size else { return nil }
            arguments.append(String(decoding: buffer[start..<index], as: UTF8.self))
            index += 1
        }
        return arguments
    }

    public func executablePath(of pid: Int32) -> String? {
        var buffer = [UInt8](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard length > 0 else { return nil }
        return String(decoding: buffer.prefix(Int(length)), as: UTF8.self)
    }
}
