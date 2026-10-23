import Foundation
import HookProtocol
import XCTest

final class TerminalLocationTests: XCTestCase {
    private func marked(_ environment: [String: String]) throws -> ClaudeEvent {
        let input = try JSONSerialization.data(withJSONObject: [
            "hook_event_name": "SessionStart", "session_id": "session-1", "cwd": "/p/project",
        ])
        var event = try XCTUnwrap(EventProjection.project(input))
        TerminalLocation.mark(&event, environment: environment)
        return event
    }

    func testTerminalAppAndOrcaTerminalComeFromTheEnvironment() throws {
        let event = try marked([
            "__CFBundleIdentifier": "com.stablyai.orca",
            "ORCA_TERMINAL_HANDLE": "term_ed6717a3-a9b4-475c-b51a-bf72e39228c3",
            "TERM_PROGRAM": "Orca",
        ])
        XCTAssertEqual(event.terminalApp, "com.stablyai.orca")
        XCTAssertEqual(event.orcaTerminal, "term_ed6717a3-a9b4-475c-b51a-bf72e39228c3")
    }

    func testMissingOrMalformedValuesAreLeftOut() throws {
        XCTAssertNil(try marked([:]).terminalApp)
        XCTAssertNil(try marked([:]).orcaTerminal)
        for app in ["", "Terminal", ".com.apple", "com.apple.", "com..apple", "-a.b", "com.-x", "com apple", "com/apple.x", String(repeating: "a.", count: 128) + "b"] {
            XCTAssertNil(try marked(["__CFBundleIdentifier": app]).terminalApp, app)
        }
        for handle in ["", "term_", "term_a b", "term_../x", "pane_1", "term_" + String(repeating: "a", count: 129)] {
            XCTAssertNil(try marked(["ORCA_TERMINAL_HANDLE": handle]).orcaTerminal, handle)
        }
    }
}
