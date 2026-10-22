export const MAX_FRAME_BYTES = 8192;
export const hookEvents = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "PostToolBatch",
] as const;
export type HookEventName = (typeof hookEvents)[number];

// Provider metadata only. Receipt order and promptId are not event sequence IDs.
export interface ClaudeEvent {
  eventName: HookEventName;
  sessionId: string;
  project: string;
  promptId?: string;
  agentId?: string;
  permissionMode?: string;
  toolName?: string;
  toolUseId?: string;
  notificationType?: "permission_prompt";
  isInterrupt?: boolean;
  stopHookActive?: boolean;
  childAgentId?: string;
  childStatus?: "completed" | "async_launched" | "resumed";
  toolCalls?: { toolName: string; toolUseId: string }[];
  backgroundTasks?: { id: string; type: string; status: string }[];
  interactive?: boolean;
  inputFingerprint?: string;
}
export interface Endpoint {
  version: 1;
  epoch: string;
  token: string;
  socketPath: string;
}
export interface Frame {
  version: 1;
  epoch: string;
  token: string;
  // One helper emission's transport identity, never provider causality.
  eventId: string;
  event: ClaudeEvent;
}
export interface TransportReceipt {
  eventId: string;
  // Local authenticated receipt order, not provider chronology.
  receivedSeq: number;
  disposition: "queued" | "duplicate" | "overflow";
  event: ClaudeEvent;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}
function isText(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) >= 1 &&
    Buffer.byteLength(value) <= limit &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
export function isEpoch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
}
export function isToken(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
const fields = new Set([
  "eventName",
  "sessionId",
  "project",
  "promptId",
  "agentId",
  "permissionMode",
  "toolName",
  "toolUseId",
  "notificationType",
  "isInterrupt",
  "stopHookActive",
  "childAgentId",
  "childStatus",
  "toolCalls",
  "backgroundTasks",
  "interactive",
  "inputFingerprint",
]);
const fingerprintedEvents = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
];
export function isClaudeEvent(value: unknown): value is ClaudeEvent {
  if (!isRecord(value) || Object.keys(value).some((key) => !fields.has(key)))
    return false;
  if (
    !(hookEvents as readonly unknown[]).includes(value.eventName) ||
    !isId(value.sessionId) ||
    !isText(value.project, 256)
  )
    return false;
  for (const field of ["promptId", "agentId", "toolUseId", "childAgentId"]) {
    if (field in value && !isId(value[field])) return false;
  }
  for (const field of ["toolName", "permissionMode"]) {
    if (field in value && !isText(value[field], 128)) return false;
  }
  if (
    "inputFingerprint" in value &&
    (!fingerprintedEvents.includes(String(value.eventName)) ||
      typeof value.inputFingerprint !== "string" ||
      !/^[0-9a-f]{32}$/.test(value.inputFingerprint))
  )
    return false;
  if (
    "interactive" in value &&
    value.eventName !== "PermissionRequest" &&
    value.eventName !== "Notification"
  )
    return false;
  for (const field of ["isInterrupt", "stopHookActive", "interactive"]) {
    if (field in value && typeof value[field] !== "boolean") return false;
  }
  if (
    "notificationType" in value &&
    value.notificationType !== "permission_prompt"
  )
    return false;
  if (
    "childStatus" in value &&
    value.childStatus !== "completed" &&
    value.childStatus !== "async_launched" &&
    value.childStatus !== "resumed"
  )
    return false;
  if (
    value.eventName === "Notification" &&
    value.notificationType !== "permission_prompt"
  )
    return false;
  if (
    ["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(
      String(value.eventName),
    ) &&
    (!isText(value.toolName, 128) || !isId(value.toolUseId))
  )
    return false;
  // PermissionRequest has no documented tool_use_id. Never invent one.
  if (value.eventName === "PermissionRequest" && !isText(value.toolName, 128))
    return false;
  if ("toolCalls" in value) {
    if (
      !Array.isArray(value.toolCalls) ||
      value.toolCalls.length > 128 ||
      value.toolCalls.some(
        (call) =>
          !isRecord(call) ||
          Object.keys(call).length !== 2 ||
          !isText(call.toolName, 128) ||
          !isId(call.toolUseId),
      )
    )
      return false;
  }
  if ("backgroundTasks" in value) {
    if (
      !Array.isArray(value.backgroundTasks) ||
      value.backgroundTasks.length > 128 ||
      value.backgroundTasks.some(
        (task) =>
          !isRecord(task) ||
          Object.keys(task).length !== 3 ||
          !isId(task.id) ||
          !isText(task.type, 128) ||
          !isText(task.status, 128),
      )
    )
      return false;
  }
  return true;
}
export function decodeFrame(bytes: Uint8Array): Frame | null {
  if (bytes.byteLength > MAX_FRAME_BYTES) return null;
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 5 ||
      value.version !== 1 ||
      !isEpoch(value.epoch) ||
      !isToken(value.token) ||
      !isEpoch(value.eventId) ||
      !isClaudeEvent(value.event)
    )
      return null;
    return {
      version: 1,
      epoch: value.epoch,
      token: value.token,
      eventId: value.eventId,
      event: value.event,
    };
  } catch {
    return null;
  }
}
