import type { ClaudeEvent } from "../integration/claude/protocol.ts";
import {
  semanticStates as priority,
  type SemanticState,
  type Snapshot,
} from "../shared/ui-contract.ts";

const MAX_SESSIONS = 128;
const MAX_ASKS = 32;
const MAX_PENDING = 64;
const MAX_ENDED = 256;
const reasons: Record<SemanticState, string> = {
  idle: "다음 요청을 기다리고 있어요.",
  working: "작업하고 있어요.",
  unknown:
    "놓친 신호가 있어 상태를 확인할 수 없어요. 다음 요청부터 다시 확인해요.",
  asking: "승인이나 질문 응답이 필요해 보여요.",
};
const observations: Record<SemanticState, string> = {
  idle: "Claude Code가 다음 요청을 기다리고 있어요.",
  working: "Claude Code가 작업하고 있어요.",
  unknown:
    "놓친 신호가 있어 일부 세션의 상태를 확인할 수 없어요. 해당 세션에 다음 요청을 보내면 다시 확인해요.",
  asking: "승인이나 질문 응답이 필요해 보여요.",
};

interface Session {
  project: string;
  base: "idle" | "working";
  unknown: boolean;
  idAsks: Set<string>;
  fingerprintAsks: Map<string, number>;
  unkeyedAsk: boolean;
  pending: Map<string, string>;
}

function askCount(session: Session): number {
  let count = session.idAsks.size + (session.unkeyedAsk ? 1 : 0);
  for (const value of session.fingerprintAsks.values()) count += value;
  return count;
}

function clearAsks(session: Session): void {
  session.idAsks.clear();
  session.fingerprintAsks.clear();
  session.unkeyedAsk = false;
}

function addAsk(
  session: Session,
  key: { id: string } | { fingerprint: string } | null,
): void {
  if (key && "id" in key && session.idAsks.has(key.id)) return;
  if (!key && session.unkeyedAsk) return;
  if (askCount(session) >= MAX_ASKS) {
    clearAsks(session);
    session.unknown = true;
    return;
  }
  if (!key) session.unkeyedAsk = true;
  else if ("id" in key) session.idAsks.add(key.id);
  else
    session.fingerprintAsks.set(
      key.fingerprint,
      (session.fingerprintAsks.get(key.fingerprint) ?? 0) + 1,
    );
}

function display(session: Session): SemanticState {
  if (
    session.idAsks.size > 0 ||
    session.fingerprintAsks.size > 0 ||
    session.unkeyedAsk
  )
    return "asking";
  return session.unknown ? "unknown" : session.base;
}

export class Observations {
  private readonly sessions = new Map<string, Session>();
  private readonly ended = new Set<string>();
  private lossNotice = false;
  private lossSeen = false;
  private failed = false;

  receive(event: ClaudeEvent): void {
    this.lossNotice = false;
    if (event.eventName === "SessionEnd" && !event.agentId) {
      this.sessions.delete(event.sessionId);
      this.ended.delete(event.sessionId);
      if (this.ended.size >= MAX_ENDED)
        this.ended.delete(this.ended.values().next().value!);
      this.ended.add(event.sessionId);
      return;
    }
    const opensTurn =
      !event.agentId &&
      (event.eventName === "SessionStart" ||
        event.eventName === "UserPromptSubmit");
    let session = this.sessions.get(event.sessionId);
    if (!session) {
      if (this.ended.has(event.sessionId) && !opensTurn) return;
      this.ended.delete(event.sessionId);
      if (this.sessions.size >= MAX_SESSIONS) {
        this.loseIntegrity();
        return;
      }
      session = {
        project: event.project,
        base: "idle",
        unknown: this.lossSeen && !opensTurn,
        idAsks: new Set(),
        fingerprintAsks: new Map(),
        unkeyedAsk: false,
        pending: new Map(),
      };
      this.sessions.set(event.sessionId, session);
    }
    session.project = event.project;
    const activity = (): void => {
      if (!(event.agentId && session.base === "idle")) session.base = "working";
    };
    switch (event.eventName) {
      case "UserPromptSubmit":
        session.base = "working";
        session.unknown = false;
        clearAsks(session);
        session.pending.clear();
        break;
      case "PreToolUse":
        if (event.toolUseId && event.inputFingerprint) {
          session.pending.delete(event.toolUseId);
          if (session.pending.size >= MAX_PENDING)
            session.pending.delete(session.pending.keys().next().value!);
          session.pending.set(event.toolUseId, event.inputFingerprint);
        }
        activity();
        if (event.toolName === "AskUserQuestion" && event.toolUseId)
          addAsk(session, { id: event.toolUseId });
        break;
      case "PermissionRequest": {
        activity();
        if (event.interactive === false) break;
        if (event.toolUseId) {
          addAsk(session, { id: event.toolUseId });
          break;
        }
        const fingerprint = event.inputFingerprint;
        if (!fingerprint) {
          addAsk(session, null);
          break;
        }
        const matches = [...session.pending].filter(
          ([, value]) => value === fingerprint,
        );
        addAsk(
          session,
          matches.length === 1 ? { id: matches[0]![0] } : { fingerprint },
        );
        break;
      }
      case "Notification":
        if (event.interactive === false) break;
        if (askCount(session) === 0) addAsk(session, null);
        break;
      case "PostToolUse":
      case "PostToolUseFailure":
        if (event.eventName === "PostToolUseFailure" && event.isInterrupt) {
          clearAsks(session);
          session.pending.clear();
          session.base = "idle";
          break;
        }
        if (event.toolUseId) session.pending.delete(event.toolUseId);
        if (!(event.toolUseId && session.idAsks.delete(event.toolUseId))) {
          const count = event.inputFingerprint
            ? session.fingerprintAsks.get(event.inputFingerprint)
            : undefined;
          if (count !== undefined)
            session.fingerprintAsks.delete(event.inputFingerprint!);
          if (count !== undefined && count > 1) session.unknown = true;
        }
        session.unkeyedAsk = false;
        activity();
        break;
      case "PostToolBatch":
        for (const call of event.toolCalls ?? []) {
          session.idAsks.delete(call.toolUseId);
          session.pending.delete(call.toolUseId);
        }
        session.unkeyedAsk = false;
        break;
      case "Stop":
      case "StopFailure":
        if (event.agentId) break;
        session.base = "idle";
        clearAsks(session);
        session.pending.clear();
        break;
      default:
        break;
    }
  }

  loseIntegrity(): void {
    this.lossNotice = true;
    this.lossSeen = true;
    for (const session of this.sessions.values()) session.unknown = true;
  }

  receiverFailed(): void {
    this.failed = true;
  }

  snapshot(): Snapshot {
    const ids = [...this.sessions.keys()];
    const states = ids.map((id) => display(this.sessions.get(id)!));
    if (this.failed || this.lossNotice) states.push("unknown");
    const state = states.reduce<SemanticState>(
      (highest, next) =>
        priority.indexOf(next) > priority.indexOf(highest) ? next : highest,
      "idle",
    );
    return {
      state,
      observation: this.failed
        ? "Claude Code 신호 수신을 시작하지 못해 상태를 확인할 수 없어요."
        : ids.length > 0
          ? observations[state]
          : this.lossNotice
            ? "놓친 신호가 있어 상태를 확인할 수 없어요. 다음 신호를 받으면 다시 확인해요."
            : "아직 Claude Code 신호를 수신하지 않았어요.",
      sessions: ids.map((id, index) => {
        let length = Math.min(8, id.length);
        while (
          length < id.length &&
          ids.some(
            (other) =>
              other !== id && other.slice(0, length) === id.slice(0, length),
          )
        )
          length++;
        return {
          id: id.slice(0, length),
          project: this.sessions.get(id)!.project,
          state: states[index]!,
          reason: reasons[states[index]!],
        };
      }),
    };
  }
}
