public enum TerminalLocation {
    public static func mark(_ event: inout ClaudeEvent, environment: [String: String]) {
        event.terminalApp = environment["__CFBundleIdentifier"].flatMap {
            isBundleIdentifier($0) ? $0 : nil
        }
        event.orcaTerminal = environment["ORCA_TERMINAL_HANDLE"].flatMap {
            isOrcaHandle($0) ? $0 : nil
        }
    }

    private static func isBundleIdentifier(_ value: String) -> Bool {
        let parts = value.utf8.split(separator: 46, omittingEmptySubsequences: false)
        return value.utf8.count <= 255 && parts.count > 1 && parts.allSatisfy { part in
            // A leading dash would read as an option to open(1).
            part.first.map(isAlphanumeric) == true && part.allSatisfy { isAlphanumeric($0) || $0 == 45 }
        }
    }

    private static func isOrcaHandle(_ value: String) -> Bool {
        guard value.hasPrefix("term_") else { return false }
        let rest = value.utf8.dropFirst(5)
        return (1...128).contains(rest.count) && rest.allSatisfy { isAlphanumeric($0) || $0 == 45 }
    }

    private static func isAlphanumeric(_ byte: UInt8) -> Bool {
        (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte)
    }
}
