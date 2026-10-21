import Darwin
import HookProtocol
import XCTest

private struct FakeProcess {
    var parent: Int32?
    var arguments: [String]?
    var path: String?
}

private struct FakeTable: ProcessTable {
    var processes: [Int32: FakeProcess]

    func parent(of pid: Int32) -> Int32? { processes[pid]?.parent }
    func arguments(of pid: Int32) -> [String]? { processes[pid]?.arguments }
    func executablePath(of pid: Int32) -> String? { processes[pid]?.path }
}

final class ProcessAncestryTests: XCTestCase {
    private let shell = FakeProcess(parent: 100, arguments: ["/bin/sh", "-c", "helper"], path: "/bin/sh")

    private func claude(_ arguments: [String] = ["claude"], parent: Int32 = 1) -> FakeProcess {
        FakeProcess(
            parent: parent, arguments: arguments,
            path: "/Users/u/.local/share/claude/versions/2.1.0"
        )
    }

    private func check(
        _ processes: [Int32: FakeProcess], start: Int32 = 200,
        environment: [String: String] = [:], isActive: () -> Bool = { true }
    ) -> Bool? {
        ProcessAncestry.interactivity(
            environment: environment, start: start,
            table: FakeTable(processes: processes), isActive: isActive
        )
    }

    func testClaudeReachedThroughShellIsInteractive() {
        XCTAssertEqual(check([200: shell, 100: claude()]), true)
    }

    func testClaudeAsDirectParentIsInteractive() {
        XCTAssertEqual(check([100: claude()], start: 100), true)
    }

    func testPrintModeFlagsAreNonInteractive() {
        for flag in ["-p", "--print", "--print=json"] {
            XCTAssertEqual(check([200: shell, 100: claude(["claude", "--verbose", flag])]), false, flag)
        }
        XCTAssertEqual(check([200: shell, 100: claude(["claude", "--printer"])]), true)
        XCTAssertEqual(check([200: shell, 100: claude(["-p"])]), true)
    }

    func testRecognisesClaudeByNameVersionsPathOrNodePackage() {
        let named = FakeProcess(parent: 1, arguments: ["/opt/bin/claude", "-p"], path: "/opt/bin/x")
        XCTAssertEqual(check([200: shell, 100: named]), false)
        let versioned = FakeProcess(parent: 1, arguments: ["2.1.0"], path: "/a/claude/versions/2.1.0")
        XCTAssertEqual(check([200: shell, 100: versioned]), true)
        let node = FakeProcess(
            parent: 1,
            arguments: ["node", "/lib/node_modules/@anthropic-ai/claude-code/cli.js", "--print"],
            path: "/usr/local/bin/node"
        )
        XCTAssertEqual(check([200: shell, 100: node]), false)
        let otherNode = FakeProcess(parent: 1, arguments: ["node", "server.js"], path: "/usr/local/bin/node")
        XCTAssertNil(check([200: shell, 100: otherNode]))
    }

    func testClaudeBeyondFourAncestorsIsUndetermined() {
        var processes: [Int32: FakeProcess] = [100: claude()]
        for pid in Int32(201)...205 {
            processes[pid] = FakeProcess(parent: pid == 205 ? 100 : pid + 1, arguments: ["sh"], path: "/bin/sh")
        }
        XCTAssertNil(check(processes, start: 201))
        XCTAssertEqual(check(processes, start: 203), true)
    }

    func testClaudePidOnlyTrustsThatProcess() {
        let wrapper = FakeProcess(parent: 100, arguments: ["node", "wrapper.mjs", "-p"], path: "/usr/bin/node")
        XCTAssertNil(check([200: shell, 150: wrapper, 100: claude()], environment: ["CLAUDE_PID": "150"]))
        let chain: [Int32: FakeProcess] = [
            200: FakeProcess(parent: 150, arguments: ["/bin/sh"], path: "/bin/sh"), 150: wrapper,
            100: claude(),
        ]
        XCTAssertEqual(check(chain, environment: ["CLAUDE_PID": "150"]), false)
        XCTAssertNil(check(chain, environment: ["CLAUDE_PID": "999"]))
        XCTAssertNil(check(chain, environment: ["CLAUDE_PID": "abc"]))
        XCTAssertEqual(check(chain, environment: ["CLAUDE_PID": "100"]), true)
    }

    func testUnreadableArgumentsAreUndetermined() {
        let hidden = FakeProcess(parent: 1, arguments: nil, path: "/a/claude/versions/1")
        XCTAssertNil(check([200: shell, 100: hidden]))
    }

    func testCyclesAndInitStopTheWalk() {
        let a = FakeProcess(parent: 201, arguments: ["sh"], path: "/bin/sh")
        let b = FakeProcess(parent: 200, arguments: ["sh"], path: "/bin/sh")
        XCTAssertNil(check([200: a, 201: b]))
        XCTAssertNil(check([200: FakeProcess(parent: 1, arguments: ["sh"], path: "/bin/sh")]))
        XCTAssertNil(check([:], start: 1))
    }

    func testExpiredDeadlineStopsBeforeReadingProcesses() {
        XCTAssertNil(check([200: shell, 100: claude()], isActive: { false }))
        var calls = 0
        XCTAssertNil(check([200: shell, 100: claude()], isActive: {
            calls += 1
            return calls < 2
        }))
    }

    func testAttendedEnvironmentOverridesTheWalk() {
        let printing: [Int32: FakeProcess] = [200: shell, 100: claude(["claude", "-p"])]
        XCTAssertEqual(check(printing, environment: ["CLAUDE_CODE_SESSION_ATTENDED": "1"]), true)
        XCTAssertEqual(check([200: shell, 100: claude()], environment: ["CLAUDE_CODE_SESSION_ATTENDED": "0"]), false)
        XCTAssertEqual(check([:], environment: ["CLAUDE_CODE_SESSION_ATTENDED": "0"]), false)
        XCTAssertEqual(check(printing), false)
        XCTAssertEqual(check(printing, environment: ["CLAUDE_CODE_SESSION_ATTENDED": "yes"]), false)
        XCTAssertEqual(check([200: shell, 100: claude()], environment: ["CLAUDE_CODE_SESSION_ATTENDED": " 1"]), true)
        XCTAssertNil(check([:], environment: ["CLAUDE_CODE_SESSION_ATTENDED": "true"]))
    }

    func testDarwinTableReadsThisProcess() throws {
        let table = DarwinProcessTable()
        let pid = getpid()
        XCTAssertEqual(table.parent(of: pid), getppid())
        let arguments = try XCTUnwrap(table.arguments(of: pid))
        XCTAssertEqual(arguments, CommandLine.arguments)
        XCTAssertNotNil(table.executablePath(of: pid))
        XCTAssertNil(table.parent(of: -5))
    }
}
