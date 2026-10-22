import Foundation

public struct ClaudeEvent: Encodable, Equatable, Sendable {
    public struct ToolCall: Encodable, Equatable, Sendable {
        public let toolName: String
        public let toolUseId: String
    }

    public struct BackgroundTask: Encodable, Equatable, Sendable {
        public let id: String
        public let type: String
        public let status: String
    }

    public let eventName: String
    public let sessionId: String
    public let project: String
    public let promptId: String?
    public let agentId: String?
    public let permissionMode: String?
    public let toolName: String?
    public let toolUseId: String?
    public let notificationType: String?
    public let isInterrupt: Bool?
    public let stopHookActive: Bool?
    public let childAgentId: String?
    public let childStatus: String?
    public let toolCalls: [ToolCall]?
    public let backgroundTasks: [BackgroundTask]?
    public let inputFingerprint: String?
    public var interactive: Bool?
}

public enum EventProjection {
    public static let maximumInputBytes = 1_048_576
    public static let maximumFingerprintedInputBytes = 65_536

    // Only this allowlisted value escapes decoding; raw hook payloads are never retained.
    public static func project(_ data: Data, fingerprintKey: Data? = nil) -> ClaudeEvent? {
        guard data.count <= maximumInputBytes else { return nil }
        let decoder = JSONDecoder()
        if let fingerprintKey, data.count <= maximumFingerprintedInputBytes {
            decoder.userInfo[DecodedProjection.fingerprintKey] = fingerprintKey
        }
        return try? decoder.decode(DecodedProjection.self, from: data).event
    }
}

private enum ProjectionError: Error {
    case invalidMetadata
}

private enum RawKey: String, CodingKey {
    case eventName = "hook_event_name"
    case sessionId = "session_id"
    case cwd
    case promptId = "prompt_id"
    case agentId = "agent_id"
    case permissionMode = "permission_mode"
    case toolName = "tool_name"
    case toolUseId = "tool_use_id"
    case notificationType = "notification_type"
    case isInterrupt = "is_interrupt"
    case stopHookActive = "stop_hook_active"
    case toolResponse = "tool_response"
    case toolCalls = "tool_calls"
    case backgroundTasks = "background_tasks"
    case toolInput = "tool_input"
}

private extension KeyedDecodingContainer {
    // Unlike decodeIfPresent, an explicitly null metadata field is malformed.
    func present<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T? {
        guard contains(key) else { return nil }
        return try decode(type, forKey: key)
    }
}

private func isId(_ value: String) -> Bool {
    let bytes = value.utf8
    return (1...128).contains(bytes.count) && bytes.allSatisfy {
        (65...90).contains($0) || (97...122).contains($0)
            || (48...57).contains($0) || $0 == 46 || $0 == 95
            || $0 == 58 || $0 == 45
    }
}

private func hasNoControls(_ value: String) -> Bool {
    value.unicodeScalars.allSatisfy { $0.value > 31 && $0.value != 127 }
}

private func isText(_ value: String, limit: Int) -> Bool {
    (1...limit).contains(value.utf8.count) && hasNoControls(value)
}

private func optionalId(
    _ values: KeyedDecodingContainer<RawKey>, _ key: RawKey
) throws -> String? {
    let value = try values.present(String.self, forKey: key)
    if let value, !isId(value) { throw ProjectionError.invalidMetadata }
    return value
}

private func optionalText(
    _ values: KeyedDecodingContainer<RawKey>, _ key: RawKey
) throws -> String? {
    let value = try values.present(String.self, forKey: key)
    if let value, !isText(value, limit: 128) { throw ProjectionError.invalidMetadata }
    return value
}

private struct RawToolCall: Decodable {
    let toolName: String
    let toolUseId: String

    enum CodingKeys: String, CodingKey {
        case toolName = "tool_name"
        case toolUseId = "tool_use_id"
    }
}

private struct RawBackgroundTask: Decodable {
    let id: String
    let type: String
    let status: String
}

private struct ResumeResponse: Decodable {
    let success: Bool?
    let resumedAgentId: String?
}

private struct AgentResponse: Decodable {
    let agentId: String?
    let status: String?

    enum CodingKeys: String, CodingKey {
        case agentId
        case status
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        agentId = try values.present(String.self, forKey: .agentId)
        status = try values.present(String.self, forKey: .status)
        if let agentId, !isId(agentId) { throw ProjectionError.invalidMetadata }
        if let status, status != "completed" && status != "async_launched" {
            throw ProjectionError.invalidMetadata
        }
    }
}

private struct DecodedProjection: Decodable {
    let event: ClaudeEvent

    static let fingerprintKey = CodingUserInfoKey(rawValue: "watchling.fingerprintKey")!
    private static let fingerprintedEvents: Set<String> = [
        "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure",
    ]

    private static let supportedEvents: Set<String> = [
        "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse",
        "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Notification",
        "SubagentStart", "SubagentStop", "Stop", "StopFailure", "PostToolBatch",
    ]

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: RawKey.self)
        let eventName = try values.decode(String.self, forKey: .eventName)
        let sessionId = try values.decode(String.self, forKey: .sessionId)
        let cwd = try values.decode(String.self, forKey: .cwd)
        guard Self.supportedEvents.contains(eventName), isId(sessionId),
            hasNoControls(cwd),
            let basename = cwd.split(separator: "/", omittingEmptySubsequences: true).last
        else { throw ProjectionError.invalidMetadata }
        let project = String(basename)
        guard isText(project, limit: 256) else { throw ProjectionError.invalidMetadata }

        let promptId = try optionalId(values, .promptId)
        let agentId = try optionalId(values, .agentId)
        let permissionMode = try optionalText(values, .permissionMode)
        let toolName = try optionalText(values, .toolName)
        let toolUseId = try optionalId(values, .toolUseId)
        let notificationType = try values.present(String.self, forKey: .notificationType)
        let isInterrupt = try values.present(Bool.self, forKey: .isInterrupt)
        let stopHookActive = try values.present(Bool.self, forKey: .stopHookActive)

        if let notificationType, notificationType != "permission_prompt" {
            throw ProjectionError.invalidMetadata
        }
        if eventName == "Notification" && notificationType != "permission_prompt" {
            throw ProjectionError.invalidMetadata
        }
        if ["PreToolUse", "PostToolUse", "PostToolUseFailure"].contains(eventName),
            toolName == nil || toolUseId == nil
        { throw ProjectionError.invalidMetadata }
        if eventName == "PermissionRequest" && toolName == nil {
            throw ProjectionError.invalidMetadata
        }

        var toolCalls: [ClaudeEvent.ToolCall]?
        if let calls = try values.present([RawToolCall].self, forKey: .toolCalls) {
            guard calls.count <= 128 else { throw ProjectionError.invalidMetadata }
            toolCalls = try calls.map { call in
                guard isText(call.toolName, limit: 128), isId(call.toolUseId) else {
                    throw ProjectionError.invalidMetadata
                }
                return ClaudeEvent.ToolCall(toolName: call.toolName, toolUseId: call.toolUseId)
            }
        }

        var backgroundTasks: [ClaudeEvent.BackgroundTask]?
        if let tasks = try values.present([RawBackgroundTask].self, forKey: .backgroundTasks) {
            guard tasks.count <= 128 else { throw ProjectionError.invalidMetadata }
            backgroundTasks = try tasks.map { task in
                guard isId(task.id), isText(task.type, limit: 128),
                    isText(task.status, limit: 128)
                else { throw ProjectionError.invalidMetadata }
                return ClaudeEvent.BackgroundTask(id: task.id, type: task.type, status: task.status)
            }
        }

        var childAgentId: String?
        var childStatus: String?
        if eventName == "PostToolUse" && toolName == "Agent",
            let response = try values.present(AgentResponse.self, forKey: .toolResponse)
        {
            childAgentId = response.agentId
            childStatus = response.status
        } else if eventName == "PostToolUse" && toolName == "SendMessage",
            let response = try? values.decodeIfPresent(ResumeResponse.self, forKey: .toolResponse),
            response.success == true, let resumed = response.resumedAgentId, isId(resumed)
        {
            childAgentId = resumed
            childStatus = "resumed"
        }

        var inputFingerprint: String?
        if Self.fingerprintedEvents.contains(eventName), let toolName,
            let key = decoder.userInfo[Self.fingerprintKey] as? Data,
            let input = try? values.decodeIfPresent(CanonicalJSON.self, forKey: .toolInput)
        {
            inputFingerprint = InputFingerprint.fingerprint(toolName: toolName, input: input, key: key)
        }

        event = ClaudeEvent(
            eventName: eventName, sessionId: sessionId, project: project,
            promptId: promptId, agentId: agentId, permissionMode: permissionMode,
            toolName: toolName, toolUseId: toolUseId, notificationType: notificationType,
            isInterrupt: isInterrupt, stopHookActive: stopHookActive,
            childAgentId: childAgentId, childStatus: childStatus,
            toolCalls: toolCalls, backgroundTasks: backgroundTasks,
            inputFingerprint: inputFingerprint, interactive: nil
        )
    }
}
