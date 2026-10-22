import CryptoKit
import Foundation
import HookProtocol
import XCTest

final class FingerprintTests: XCTestCase {
    private let key = Data(repeating: 0x11, count: 32)

    private func payload(_ event: String, input: Any?, toolName: String = "Bash") throws -> Data {
        var raw: [String: Any] = [
            "hook_event_name": event,
            "session_id": "session-1",
            "cwd": "/Users/fixture/project",
            "tool_name": toolName,
            "tool_use_id": "toolu_1",
        ]
        if let input { raw["tool_input"] = input }
        return try JSONSerialization.data(withJSONObject: raw)
    }

    private func project(_ json: String, key: Data? = nil) -> ClaudeEvent? {
        EventProjection.project(Data(json.utf8), fingerprintKey: key ?? self.key)
    }

    func testCanonicalFormSortsKeysByUTF8BytesAndEscapesMinimally() throws {
        let json = #"{"b":[1,2.5,true,null],"a":"q\"\\\u0001/é","B":{"z":-3,"y":"x"},"é":0}"#
        let value = try JSONDecoder().decode(CanonicalJSON.self, from: Data(json.utf8))
        XCTAssertEqual(
            String(decoding: value.canonicalBytes, as: UTF8.self),
            #"{"B":{"y":"x","z":-3},"a":"q\"\\\u0001/é","b":[1,2.5,true,null],"é":0}"#
        )
    }

    func testFingerprintIsTruncatedHMACOverToolNameAndCanonicalInput() throws {
        let event = try XCTUnwrap(project(
            #"{"hook_event_name":"PreToolUse","session_id":"s","cwd":"/p","tool_name":"Bash","tool_use_id":"t","tool_input":{"command":"ls","timeout":5}}"#
        ))
        var message = Array("Bash".utf8)
        message.append(0)
        message.append(contentsOf: #"{"command":"ls","timeout":5}"#.utf8)
        let code = HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: key))
        let expected = code.map { String(format: "%02x", $0) }.joined().prefix(32)
        XCTAssertEqual(event.inputFingerprint, String(expected))
    }

    func testKeyOrderDoesNotChangeFingerprint() throws {
        let first = project(
            #"{"hook_event_name":"PermissionRequest","session_id":"s","cwd":"/p","tool_name":"Bash","tool_input":{"a":1,"b":{"c":"d","e":[1]}}}"#
        )
        let second = project(
            #"{"tool_input":{"b":{"e":[1],"c":"d"},"a":1},"hook_event_name":"PermissionRequest","session_id":"s","cwd":"/p","tool_name":"Bash"}"#
        )
        XCTAssertNotNil(first?.inputFingerprint)
        XCTAssertEqual(first?.inputFingerprint, second?.inputFingerprint)
    }

    func testDifferentKeyInputOrToolChangesFingerprint() throws {
        let data = try payload("PostToolUse", input: ["command": "ls"])
        let base = EventProjection.project(data, fingerprintKey: key)?.inputFingerprint
        let otherKey = EventProjection.project(
            data, fingerprintKey: Data(repeating: 0x22, count: 32)
        )?.inputFingerprint
        let otherInput = EventProjection.project(
            try payload("PostToolUse", input: ["command": "pwd"]), fingerprintKey: key
        )?.inputFingerprint
        let otherTool = EventProjection.project(
            try payload("PostToolUse", input: ["command": "ls"], toolName: "Write"), fingerprintKey: key
        )?.inputFingerprint
        XCTAssertNotNil(base)
        XCTAssertNotEqual(base, otherKey)
        XCTAssertNotEqual(base, otherInput)
        XCTAssertNotEqual(base, otherTool)
        XCTAssertTrue(base!.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) })
        XCTAssertEqual(base!.utf8.count, 32)
    }

    func testRawInputNeverAppearsInEncodedEvent() throws {
        for event in ["PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure"] {
            let projected = try XCTUnwrap(EventProjection.project(
                try payload(event, input: ["command": "FIXTURE_INPUT_SECRET", "FIXTURE_KEY_SECRET": 1]),
                fingerprintKey: key
            ))
            XCTAssertNotNil(projected.inputFingerprint)
            let encoded = String(decoding: try JSONEncoder().encode(projected), as: UTF8.self)
            XCTAssertFalse(encoded.contains("FIXTURE_INPUT_SECRET"))
            XCTAssertFalse(encoded.contains("FIXTURE_KEY_SECRET"))
            XCTAssertFalse(encoded.contains("tool_input"))
        }
    }

    func testMissingOrTooDeepInputOmitsFingerprintButKeepsEvent() throws {
        let missing = try XCTUnwrap(EventProjection.project(
            try payload("PreToolUse", input: nil), fingerprintKey: key
        ))
        XCTAssertNil(missing.inputFingerprint)
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(missing), as: UTF8.self)
            .contains("inputFingerprint"))

        var deep: Any = "leaf"
        for _ in 0..<70 { deep = [deep] }
        let tooDeep = try XCTUnwrap(EventProjection.project(
            try payload("PreToolUse", input: deep), fingerprintKey: key
        ))
        XCTAssertNil(tooDeep.inputFingerprint)

        var shallow: Any = "leaf"
        for _ in 0..<63 { shallow = [shallow] }
        XCTAssertNotNil(EventProjection.project(
            try payload("PreToolUse", input: shallow), fingerprintKey: key
        )?.inputFingerprint)
    }

    func testLargeOrWideInputOmitsFingerprintWithinBudget() throws {
        let wide = try payload("PermissionRequest", input: Array(repeating: [Int](), count: 20_000))
        let large = try payload("PermissionRequest", input: ["text": String(repeating: "x", count: 70_000)])
        for data in [wide, large] {
            let start = Date()
            let event = EventProjection.project(data, fingerprintKey: key)
            XCTAssertNotNil(event)
            XCTAssertNil(event?.inputFingerprint)
            XCTAssertLessThan(Date().timeIntervalSince(start), 0.1)
        }
    }

    func testNonToolEventsAndKeylessProjectionOmitFingerprint() throws {
        let stop = try XCTUnwrap(EventProjection.project(
            try payload("Stop", input: ["command": "ls"]), fingerprintKey: key
        ))
        XCTAssertNil(stop.inputFingerprint)
        let keyless = try XCTUnwrap(EventProjection.project(try payload("PreToolUse", input: ["a": 1])))
        XCTAssertNil(keyless.inputFingerprint)
    }

    func testKeyIsDerivedFromLowercaseHexTokenAndNeverTheTokenItself() {
        let token = Data(repeating: 0xAB, count: 32)
        let expected = Data(HMAC<SHA256>.authenticationCode(
            for: Array("watchling-fingerprint-v1".utf8), using: SymmetricKey(data: token)
        ))
        let derived = InputFingerprint.key(token: String(repeating: "ab", count: 32))
        XCTAssertEqual(derived, expected)
        XCTAssertNotEqual(derived, token)
        XCTAssertNil(InputFingerprint.key(token: String(repeating: "AB", count: 32)))
        XCTAssertNil(InputFingerprint.key(token: "ab"))
    }
}
