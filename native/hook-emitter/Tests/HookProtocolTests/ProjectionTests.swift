import Foundation
import HookProtocol
import XCTest

final class ProjectionTests: XCTestCase {
    private func input(
        _ overrides: [String: Any] = [:], removing: [String] = []
    ) throws -> Data {
        var raw: [String: Any] = [
            "hook_event_name": "SessionStart",
            "session_id": "session:fixture-1",
            "cwd": "/Users/fixture/private-project",
        ]
        raw.merge(overrides) { _, replacement in replacement }
        for key in removing { raw.removeValue(forKey: key) }
        return try JSONSerialization.data(withJSONObject: raw)
    }

    private func project(
        _ overrides: [String: Any] = [:], removing: [String] = []
    ) throws -> ClaudeEvent? {
        EventProjection.project(try input(overrides, removing: removing))
    }

    func testPermissionCandidateDoesNotRequireOrInventToolUseId() throws {
        let event = try XCTUnwrap(project([
            "hook_event_name": "PermissionRequest",
            "tool_name": "Bash",
            "permission_mode": "default",
            "prompt_id": "prompt.1",
            "tool_input": ["command": "FIXTURE_COMMAND_SECRET"],
        ]))
        XCTAssertEqual(event.eventName, "PermissionRequest")
        XCTAssertEqual(event.toolName, "Bash")
        XCTAssertEqual(event.permissionMode, "default")
        XCTAssertEqual(event.promptId, "prompt.1")
        XCTAssertNil(event.toolUseId)
        XCTAssertNil(event.notificationType)
        XCTAssertNil(try project(["hook_event_name": "PermissionRequest"]))

        let explicit = try XCTUnwrap(project([
            "hook_event_name": "PermissionRequest",
            "tool_name": "Bash",
            "tool_use_id": "tool:explicit",
        ]))
        XCTAssertEqual(explicit.toolUseId, "tool:explicit")
    }

    func testAskUserQuestionRetainsOnlyToolMetadata() throws {
        let event = try XCTUnwrap(project([
            "hook_event_name": "PreToolUse",
            "tool_name": "AskUserQuestion",
            "tool_use_id": "toolu_Ask-1",
            "tool_input": ["questions": [["question": "FIXTURE_QUESTION_SECRET"]]],
        ]))
        XCTAssertEqual(event.toolName, "AskUserQuestion")
        XCTAssertEqual(event.toolUseId, "toolu_Ask-1")
        XCTAssertNil(event.notificationType)
        let encoded = try JSONEncoder().encode(event)
        XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("FIXTURE_QUESTION_SECRET"))
    }

    func testAllowlistRemovesRawContentAndFullPathsAtEveryDepth() throws {
        let secrets = [
            "FIXTURE_PROMPT_SECRET", "FIXTURE_INPUT_SECRET", "FIXTURE_MESSAGE_SECRET",
            "FIXTURE_RESPONSE_SECRET", "FIXTURE_LIST_SECRET", "FIXTURE_TASK_SECRET",
            "FIXTURE_TRANSCRIPT_SECRET", "FIXTURE_NESTED_SECRET",
        ]
        let event = try XCTUnwrap(project([
            "hook_event_name": "PostToolUse",
            "cwd": "/Users/FIXTURE_PRIVATE_PARENT/workspace-雪/",
            "session_id": "session:fixture-1",
            "prompt_id": "prompt.1",
            "agent_id": "agent.parent",
            "permission_mode": "default",
            "tool_name": "Agent",
            "tool_use_id": "tool:agent-1",
            "is_interrupt": false,
            "stop_hook_active": true,
            "prompt": secrets[0],
            "tool_input": ["prompt": secrets[1], "path": "/private/INPUT_PATH_SECRET"],
            "message": secrets[2],
            "messages": [["content": ["text": secrets[7]]]],
            "response": secrets[3],
            "transcript_path": "/private/\(secrets[6])",
            "tool_response": [
                "agentId": "agent.child",
                "status": "async_launched",
                "content": [["text": secrets[3], "message": secrets[7]]],
                "path": "/private/RESPONSE_PATH_SECRET",
            ],
            "tool_calls": [[
                "tool_name": "Read",
                "tool_use_id": "tool:read-1",
                "tool_input": ["file_path": secrets[4]],
                "message": secrets[7],
            ]],
            "background_tasks": [[
                "id": "task.1", "type": "agent", "status": "running",
                "description": secrets[5], "response": ["text": secrets[7]],
                "path": "/private/TASK_PATH_SECRET",
            ]],
            "agent_type": "FIXTURE_AGENT_TYPE_SECRET",
            "source": "FIXTURE_SOURCE_SECRET",
            "sequence": 999,
            "timestamp": "FIXTURE_TIMESTAMP_SECRET",
            "state": "waiting-for-user",
        ]))
        XCTAssertEqual(event.project, "workspace-雪")
        XCTAssertEqual(event.childAgentId, "agent.child")
        XCTAssertEqual(event.childStatus, "async_launched")
        XCTAssertEqual(event.toolCalls?.first?.toolUseId, "tool:read-1")
        XCTAssertEqual(event.backgroundTasks?.first?.status, "running")

        let encoded = try JSONEncoder().encode(event)
        let text = String(decoding: encoded, as: UTF8.self)
        for secret in secrets + [
            "FIXTURE_PRIVATE_PARENT", "INPUT_PATH_SECRET", "RESPONSE_PATH_SECRET",
            "TASK_PATH_SECRET", "FIXTURE_AGENT_TYPE_SECRET", "FIXTURE_SOURCE_SECRET",
            "FIXTURE_TIMESTAMP_SECRET", "waiting-for-user",
        ] {
            XCTAssertFalse(text.contains(secret), "Unexpected raw fixture content")
        }
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(Set(object.keys), Set([
            "eventName", "sessionId", "project", "promptId", "agentId", "permissionMode",
            "toolName", "toolUseId", "isInterrupt", "stopHookActive", "childAgentId",
            "childStatus", "toolCalls", "backgroundTasks",
        ]))
        let call = try XCTUnwrap((object["toolCalls"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(call.keys), Set(["toolName", "toolUseId"]))
        let task = try XCTUnwrap((object["backgroundTasks"] as? [[String: Any]])?.first)
        XCTAssertEqual(Set(task.keys), Set(["id", "type", "status"]))
    }

    func testSubagentFieldsRemainProviderMetadata() throws {
        for eventName in ["SubagentStart", "SubagentStop"] {
            let event = try XCTUnwrap(project([
                "hook_event_name": eventName,
                "agent_id": "agent:sub-1",
                "prompt_id": "prompt:sub-1",
                "stop_hook_active": false,
                "is_interrupt": true,
                "agent_type": "fixture-worker",
                "last_assistant_message": "FIXTURE_ASSISTANT_SECRET",
                "agent_transcript_path": "/private/FIXTURE_TRANSCRIPT_SECRET",
            ]))
            XCTAssertEqual(event.eventName, eventName)
            XCTAssertEqual(event.agentId, "agent:sub-1")
            XCTAssertEqual(event.promptId, "prompt:sub-1")
            XCTAssertEqual(event.stopHookActive, false)
            XCTAssertEqual(event.isInterrupt, true)
            XCTAssertNil(event.childAgentId)
            XCTAssertNil(event.childStatus)
            XCTAssertNil(event.subagentKind)
        }
    }

    func testWorkflowSubagentStartProjectsOnlyTheClosedKind() throws {
        let start = try XCTUnwrap(project([
            "hook_event_name": "SubagentStart", "agent_id": "agent:wf-1",
            "agent_type": "workflow-subagent",
        ]))
        XCTAssertEqual(start.agentId, "agent:wf-1")
        XCTAssertEqual(start.subagentKind, "workflow")
        let encoded = String(decoding: try JSONEncoder().encode(start), as: UTF8.self)
        XCTAssertFalse(encoded.contains("workflow-subagent"))

        let stop = try XCTUnwrap(project([
            "hook_event_name": "SubagentStop", "agent_id": "agent:wf-1",
            "agent_type": "workflow-subagent",
        ]))
        XCTAssertNil(stop.subagentKind)
        for eventName in ["PostToolUse", "Stop"] {
            let other = try XCTUnwrap(project([
                "hook_event_name": eventName, "tool_name": "Workflow", "tool_use_id": "tool.1",
                "agent_type": "workflow-subagent",
            ]))
            XCTAssertNil(other.subagentKind)
        }
    }

    func testOtherAgentTypesAreNeverForwarded() throws {
        let values: [Any] = [
            "FIXTURE_CUSTOM_AGENT_SECRET", "Workflow-Subagent", "workflow-subagent ", "workflow",
            "", 1, true, NSNull(), ["workflow-subagent"], ["kind": "workflow-subagent"],
        ]
        for value in values {
            let event = try XCTUnwrap(project([
                "hook_event_name": "SubagentStart", "agent_id": "agent:sub-1", "agent_type": value,
            ]))
            XCTAssertEqual(event.agentId, "agent:sub-1")
            XCTAssertNil(event.subagentKind)
            let encoded = String(decoding: try JSONEncoder().encode(event), as: UTF8.self)
            XCTAssertFalse(encoded.contains("FIXTURE_CUSTOM_AGENT_SECRET"))
            XCTAssertFalse(encoded.contains("subagentKind"))
        }
    }

    func testAgentPostToolUseProjectsOnlyDocumentedChildMetadata() throws {
        for status in ["completed", "async_launched"] {
            let event = try XCTUnwrap(project([
                "hook_event_name": "PostToolUse",
                "tool_name": "Agent",
                "tool_use_id": "tool:agent",
                "tool_response": ["agentId": "agent:child", "status": status],
            ]))
            XCTAssertEqual(event.childAgentId, "agent:child")
            XCTAssertEqual(event.childStatus, status)
        }
        let absent = try XCTUnwrap(project([
            "hook_event_name": "PostToolUse", "tool_name": "Agent", "tool_use_id": "tool:agent",
            "child_agent_id": "not-authoritative", "child_status": "completed",
        ]))
        XCTAssertNil(absent.childAgentId)
        XCTAssertNil(absent.childStatus)

        let partialResponses: [[String: Any]] = [
            [:], ["agentId": "agent:child"], ["status": "completed"],
        ]
        for response in partialResponses {
            XCTAssertNotNil(try project([
                "hook_event_name": "PostToolUse", "tool_name": "Agent", "tool_use_id": "tool:agent",
                "tool_response": response,
            ]))
        }
    }

    func testSendMessageResumeProjectsResumedChild() throws {
        let resumed = try XCTUnwrap(project([
            "hook_event_name": "PostToolUse", "tool_name": "SendMessage", "tool_use_id": "tool:send",
            "tool_response": [
                "success": true, "message": "MESSAGE_SECRET",
                "resumedAgentId": "agent:child", "revivedAgentId": "agent:child",
            ],
        ]))
        XCTAssertEqual(resumed.childAgentId, "agent:child")
        XCTAssertEqual(resumed.childStatus, "resumed")

        let ignored: [Any] = [
            "Message sent", ["success": true], ["success": false, "resumedAgentId": "agent:child"],
            ["success": true, "resumedAgentId": "bad/id"],
        ]
        for response in ignored {
            let event = try XCTUnwrap(project([
                "hook_event_name": "PostToolUse", "tool_name": "SendMessage",
                "tool_use_id": "tool:send", "tool_response": response,
            ]))
            XCTAssertNil(event.childAgentId)
            XCTAssertNil(event.childStatus)
        }
    }

    func testChildMetadataIsNotInferredFromOtherToolsOrHooks() throws {
        for (eventName, toolName) in [
            ("PostToolUse", "Bash"), ("PostToolUse", "Task"),
            ("PreToolUse", "Agent"), ("PostToolUseFailure", "Agent"),
        ] {
            let event = try XCTUnwrap(project([
                "hook_event_name": eventName, "tool_name": toolName, "tool_use_id": "tool.1",
                "tool_response": ["agentId": "agent:child", "status": "completed"],
            ]))
            XCTAssertNil(event.childAgentId)
            XCTAssertNil(event.childStatus)
        }
    }

    func testMalformedAgentResponseMetadataRejects() throws {
        let malformed: [Any] = [
            NSNull(), "raw response", 1, [] as [Any],
            ["agentId": "bad/id"], ["agentId": 1], ["agentId": NSNull()],
            ["status": "running"], ["status": false], ["status": NSNull()],
        ]
        for response in malformed {
            XCTAssertNil(try project([
                "hook_event_name": "PostToolUse", "tool_name": "Agent", "tool_use_id": "tool.1",
                "tool_response": response,
            ]))
        }
    }

    func testOnlyPermissionPromptNotificationsSurvive() throws {
        let event = try XCTUnwrap(project([
            "hook_event_name": "Notification", "notification_type": "permission_prompt",
            "message": "FIXTURE_NOTIFICATION_SECRET",
        ]))
        XCTAssertEqual(event.notificationType, "permission_prompt")
        XCTAssertNil(event.toolUseId)
        XCTAssertNil(event.toolName)
        XCTAssertNil(try project(["hook_event_name": "Notification"]))
        let unsupportedKinds: [Any] = [
            "idle_prompt", "auth_success", "elicitation_dialog", "unknown", "", 1, NSNull(),
        ]
        for kind in unsupportedKinds {
            XCTAssertNil(try project(["hook_event_name": "Notification", "notification_type": kind]))
        }
        XCTAssertNil(try project(["notification_type": "idle_prompt"]))
    }

    func testRecognizedLifecycleEventsProjectWithoutInventedFields() throws {
        for eventName in [
            "SessionStart", "SessionEnd", "UserPromptSubmit", "Stop", "StopFailure", "PostToolBatch",
            "TurnEnded",
        ] {
            let event = try XCTUnwrap(project(["hook_event_name": eventName]))
            XCTAssertEqual(event.eventName, eventName)
            XCTAssertEqual(event.sessionId, "session:fixture-1")
            let encoded = try JSONEncoder().encode(event)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
            XCTAssertEqual(Set(object.keys), Set(["eventName", "sessionId", "project"]))
        }
        for name in ["UnknownHook", "PermissionResolved", "pretooluse", ""] {
            XCTAssertNil(try project(["hook_event_name": name]))
        }
    }

    func testToolHooksRequireNameAndId() throws {
        for name in ["PreToolUse", "PostToolUse", "PostToolUseFailure"] {
            let fields: [String: Any] = [
                "hook_event_name": name, "tool_name": "Read", "tool_use_id": "tool.1",
            ]
            XCTAssertNotNil(try project(fields))
            XCTAssertNil(try project(fields, removing: ["tool_name"]))
            XCTAssertNil(try project(fields, removing: ["tool_use_id"]))
            XCTAssertNil(try project(fields.merging(["tool_use_id": "bad/id"]) { _, new in new }))
        }
    }

    func testMalformedRequiredFieldsAndJSONReject() throws {
        let invalidTypes: [Any] = [1, true, NSNull(), [] as [Any], ["nested": "value"]]
        for field in ["hook_event_name", "session_id", "cwd"] {
            XCTAssertNil(try project(removing: [field]))
            for value in invalidTypes {
                XCTAssertNil(try project([field: value]))
            }
        }
        for cwd in ["", "/", "///", "/private/invalid\n/project"] {
            XCTAssertNil(try project(["cwd": cwd]))
        }
        for text in ["null", "[]", "true", "1", "\"string\"", "{", "{}"] {
            XCTAssertNil(EventProjection.project(Data(text.utf8)))
        }
        XCTAssertNil(EventProjection.project(Data([0xFF])))
        XCTAssertNil(EventProjection.project(Data(repeating: 0x20, count: EventProjection.maximumInputBytes + 1)))
    }

    func testIdAlphabetAndByteLimitsAreStrict() throws {
        let valid = String(repeating: "a", count: 121) + "Z09._:-"
        XCTAssertEqual(valid.utf8.count, 128)
        XCTAssertEqual(try project(["session_id": valid])?.sessionId, valid)
        let invalidTypes: [Any] = [1, true, NSNull(), [] as [Any]]
        for field in ["session_id", "prompt_id", "agent_id", "tool_use_id"] {
            for value in ["", "bad/id", "bad id", "é", "id\n", String(repeating: "a", count: 129)] {
                XCTAssertNil(try project([field: value]))
            }
            for value in invalidTypes {
                XCTAssertNil(try project([field: value]))
            }
        }
    }

    func testNonASCIIProjectUsesUTF8ByteLimitAndDropsParentPath() throws {
        let event = try XCTUnwrap(project(["cwd": "/private/fixture/café-☃/"]))
        XCTAssertEqual(event.project, "café-☃")
        let boundary = String(repeating: "é", count: 128)
        XCTAssertEqual(try project(["cwd": "/private/\(boundary)"])?.project, boundary)
        XCTAssertNil(try project(["cwd": "/private/\(boundary)x"]))
        XCTAssertNil(try project(["cwd": "/private/\(String(repeating: "é", count: 129))"]))
    }

    func testOptionalTextLimitsControlsAndBooleanTypes() throws {
        let boundary = String(repeating: "é", count: 64)
        let invalidTextTypes: [Any] = [1, false, NSNull(), [] as [Any]]
        for field in ["tool_name", "permission_mode"] {
            XCTAssertNotNil(try project([field: boundary]))
            for value in ["", boundary + "x", "line\nfeed", "tab\t", "nul\0", "del\u{7F}"] {
                XCTAssertNil(try project([field: value]))
            }
            for value in invalidTextTypes {
                XCTAssertNil(try project([field: value]))
            }
        }
        let invalidBooleanTypes: [Any] = [
            0, 1, "true", "false", NSNull(), [] as [Any], ["value": true],
        ]
        for field in ["is_interrupt", "stop_hook_active"] {
            XCTAssertNotNil(try project([field: true]))
            XCTAssertNotNil(try project([field: false]))
            for value in invalidBooleanTypes {
                XCTAssertNil(try project([field: value]))
            }
        }
    }

    func testListMetadataProjectsAndRetainsProviderOrderOnly() throws {
        let event = try XCTUnwrap(project([
            "hook_event_name": "PostToolBatch",
            "tool_calls": [
                ["tool_name": "Read", "tool_use_id": "tool:z"],
                ["tool_name": "AskUserQuestion", "tool_use_id": "tool:a"],
            ],
            "background_tasks": [
                ["id": "task:z", "type": "agent", "status": "running"],
                ["id": "task:a", "type": "shell", "status": "completed"],
            ],
        ]))
        XCTAssertEqual(event.toolCalls?.map(\.toolUseId), ["tool:z", "tool:a"])
        XCTAssertEqual(event.backgroundTasks?.map(\.id), ["task:z", "task:a"])
        let empty = try XCTUnwrap(project(["tool_calls": [] as [Any], "background_tasks": [] as [Any]]))
        XCTAssertEqual(empty.toolCalls?.count, 0)
        XCTAssertEqual(empty.backgroundTasks?.count, 0)
    }

    func testMetadataListsRejectOversizeAndMalformedEntries() throws {
        let call = ["tool_name": "Read", "tool_use_id": "tool.1"]
        let task = ["id": "task.1", "type": "agent", "status": "running"]
        XCTAssertEqual(try project(["tool_calls": Array(repeating: call, count: 128)])?.toolCalls?.count, 128)
        XCTAssertEqual(try project(["background_tasks": Array(repeating: task, count: 128)])?.backgroundTasks?.count, 128)
        XCTAssertNil(try project(["tool_calls": Array(repeating: call, count: 129)]))
        XCTAssertNil(try project(["background_tasks": Array(repeating: task, count: 129)]))

        let malformedCalls: [Any] = [
            NSNull(), "not-an-array", [:] as [String: Any], [1], [[]] as [[Any]],
            [["tool_name": "Read"]],
            [["tool_name": "", "tool_use_id": "tool.1"]],
            [["tool_name": "Read", "tool_use_id": "bad/id"]],
            [["tool_name": "Read", "tool_use_id": 1]],
            [["tool_name": String(repeating: "x", count: 129), "tool_use_id": "tool.1"]],
        ]
        for calls in malformedCalls { XCTAssertNil(try project(["tool_calls": calls])) }
        let malformedTasks: [Any] = [
            NSNull(), "not-an-array", [:] as [String: Any], [1], [[]] as [[Any]],
            [["id": "task.1", "type": "agent"]],
            [["id": "bad/id", "type": "agent", "status": "running"]],
            [["id": "task.1", "type": "", "status": "running"]],
            [["id": "task.1", "type": "agent", "status": true]],
            [["id": "task.1", "type": "agent", "status": "bad\nstatus"]],
            [["id": "task.1", "type": String(repeating: "x", count: 129), "status": "running"]],
        ]
        for tasks in malformedTasks { XCTAssertNil(try project(["background_tasks": tasks])) }
    }
}
