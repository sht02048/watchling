import type { ClaudeEvent } from "../integration/claude/protocol.ts";
import {
  semanticStates as priority,
  type SemanticState,
  type SessionDetail,
  type Snapshot,
} from "../shared/ui-contract.ts";

const MAX_SESSIONS = 128;
const MAX_ASKS = 32;
const MAX_PENDING = 64;
const MAX_ENDED = 256;
const MAX_BACKGROUND = 32;
const MAX_COMPANIONS = 3;

interface Ask {
  tool?: string;
  question: boolean;
  order: number;
}

interface Session {
  project: string;
  base: "idle" | "working";
  unknown: boolean;
  idAsks: Map<string, Ask>;
  fingerprintAsks: Map<string, Ask & { count: number }>;
  unkeyedAsk: Ask | null;
  pending: Map<string, string>;
  background: Set<string>;
  activeTool: { id: string; name: string } | null;
  shown: SemanticState;
  since: number;
}

function askCount(session: Session): number {
  let count = session.idAsks.size + (session.unkeyedAsk ? 1 : 0);
  for (const value of session.fingerprintAsks.values()) count += value.count;
  return count;
}

function clearAsks(session: Session): void {
  session.idAsks.clear();
  session.fingerprintAsks.clear();
  session.unkeyedAsk = null;
}

function addAsk(
  session: Session,
  key: { id: string } | { fingerprint: string } | null,
  ask: Ask,
): void {
  if (key && "id" in key && session.idAsks.has(key.id)) return;
  if (!key && session.unkeyedAsk) return;
  if (askCount(session) >= MAX_ASKS) {
    clearAsks(session);
    session.unknown = true;
    return;
  }
  if (!key) session.unkeyedAsk = ask;
  else if ("id" in key) session.idAsks.set(key.id, ask);
  else
    session.fingerprintAsks.set(key.fingerprint, {
      ...ask,
      count: (session.fingerprintAsks.get(key.fingerprint)?.count ?? 0) + 1,
    });
}

function display(session: Session): SemanticState {
  if (
    session.idAsks.size > 0 ||
    session.fingerprintAsks.size > 0 ||
    session.unkeyedAsk
  )
    return "asking";
  if (session.unknown) return "unknown";
  if (session.base === "idle" && session.background.size > 0)
    return "background";
  return session.base;
}

function detail(session: Session, state: SemanticState): SessionDetail | null {
  if (state === "asking") {
    const asks = [
      ...session.idAsks.values(),
      ...session.fingerprintAsks.values(),
      ...(session.unkeyedAsk ? [session.unkeyedAsk] : []),
    ];
    if (asks.some((ask) => ask.question)) return { kind: "question" };
    const latest = asks.reduce((a, b) => (b.order > a.order ? b : a));
    return latest.tool
      ? { kind: "permission", tool: latest.tool }
      : { kind: "permission" };
  }
  if (state === "working")
    return session.activeTool
      ? { kind: "tool", tool: session.activeTool.name }
      : null;
  if (state === "background")
    return { kind: "agents", count: session.background.size };
  return null;
}

function shortIds(ids: readonly string[]): string[] {
  return ids.map((id) => {
    let length = Math.min(4, id.length);
    while (
      length < id.length &&
      ids.some(
        (other) =>
          other !== id && other.slice(0, length) === id.slice(0, length),
      )
    )
      length++;
    return id.slice(0, length);
  });
}

export class Observations {
  private readonly sessions = new Map<string, Session>();
  private readonly ended = new Set<string>();
  private lossNotice = false;
  private lossSeen = false;
  private failed = false;
  private askOrder = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  receive(event: ClaudeEvent): void {
    this.lossNotice = false;
    this.apply(event);
    this.touch();
  }

  private touch(): void {
    for (const session of this.sessions.values()) {
      const state = display(session);
      if (state === session.shown) continue;
      session.shown = state;
      session.since = this.now();
    }
  }

  private apply(event: ClaudeEvent): void {
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
        idAsks: new Map(),
        fingerprintAsks: new Map(),
        unkeyedAsk: null,
        pending: new Map(),
        background: new Set(),
        activeTool: null,
        shown: "idle",
        since: this.now(),
      };
      session.shown = display(session);
      this.sessions.set(event.sessionId, session);
    }
    session.project = event.project;
    if (event.backgroundTasks?.length === 0) session.background.clear();
    const activity = (): void => {
      if (!(event.agentId && session.base === "idle")) session.base = "working";
    };
    const ask = (): Ask => ({
      ...(event.toolName ? { tool: event.toolName } : {}),
      question: event.toolName === "AskUserQuestion",
      order: ++this.askOrder,
    });
    const endTool = (toolUseId: string | undefined): void => {
      if (toolUseId && session.activeTool?.id === toolUseId)
        session.activeTool = null;
    };
    switch (event.eventName) {
      case "UserPromptSubmit":
        session.base = "working";
        session.unknown = false;
        clearAsks(session);
        session.pending.clear();
        session.activeTool = null;
        break;
      case "PreToolUse":
        if (event.toolUseId && event.inputFingerprint) {
          session.pending.delete(event.toolUseId);
          if (session.pending.size >= MAX_PENDING)
            session.pending.delete(session.pending.keys().next().value!);
          session.pending.set(event.toolUseId, event.inputFingerprint);
        }
        activity();
        if (!event.agentId && event.toolName && event.toolUseId)
          session.activeTool = { id: event.toolUseId, name: event.toolName };
        if (event.toolName === "AskUserQuestion" && event.toolUseId)
          addAsk(session, { id: event.toolUseId }, ask());
        break;
      case "PermissionRequest": {
        activity();
        if (event.interactive === false) break;
        if (event.toolUseId) {
          addAsk(session, { id: event.toolUseId }, ask());
          break;
        }
        const fingerprint = event.inputFingerprint;
        if (!fingerprint) {
          addAsk(session, null, ask());
          break;
        }
        const matches = [...session.pending].filter(
          ([, value]) => value === fingerprint,
        );
        addAsk(
          session,
          matches.length === 1 ? { id: matches[0]![0] } : { fingerprint },
          ask(),
        );
        break;
      }
      case "Notification":
        if (event.interactive === false) break;
        if (askCount(session) === 0)
          addAsk(session, null, { question: false, order: ++this.askOrder });
        break;
      case "PostToolUse":
      case "PostToolUseFailure":
        endTool(event.toolUseId);
        if (event.eventName === "PostToolUseFailure" && event.isInterrupt) {
          clearAsks(session);
          session.pending.clear();
          session.base = "idle";
          break;
        }
        if (event.toolUseId) session.pending.delete(event.toolUseId);
        if (!(event.toolUseId && session.idAsks.delete(event.toolUseId))) {
          const count = event.inputFingerprint
            ? session.fingerprintAsks.get(event.inputFingerprint)?.count
            : undefined;
          if (count !== undefined)
            session.fingerprintAsks.delete(event.inputFingerprint!);
          if (count !== undefined && count > 1) session.unknown = true;
        }
        session.unkeyedAsk = null;
        if (event.childStatus === "async_launched" && event.childAgentId) {
          if (session.background.size >= MAX_BACKGROUND) session.unknown = true;
          else session.background.add(event.childAgentId);
        }
        activity();
        break;
      case "SubagentStop":
        if (event.agentId) session.background.delete(event.agentId);
        break;
      case "PostToolBatch":
        for (const call of event.toolCalls ?? []) {
          session.idAsks.delete(call.toolUseId);
          session.pending.delete(call.toolUseId);
          endTool(call.toolUseId);
        }
        session.unkeyedAsk = null;
        break;
      case "Stop":
      case "StopFailure":
        if (event.agentId) break;
        session.base = "idle";
        clearAsks(session);
        session.pending.clear();
        session.activeTool = null;
        break;
      default:
        break;
    }
  }

  loseIntegrity(): void {
    this.lossNotice = true;
    this.lossSeen = true;
    for (const session of this.sessions.values()) session.unknown = true;
    this.touch();
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
    let companions = 0;
    for (const session of this.sessions.values())
      companions += session.background.size;
    const projects = new Map<string, string[]>();
    for (const [id, session] of this.sessions)
      projects.set(session.project, [
        ...(projects.get(session.project) ?? []),
        id,
      ]);
    const short = new Map<string, string>();
    for (const group of projects.values()) {
      const values = shortIds(group);
      group.forEach((id, index) => short.set(id, values[index]!));
    }
    return {
      state,
      companions: Math.min(MAX_COMPANIONS, companions),
      sessions: ids.map((id, index) => {
        const session = this.sessions.get(id)!;
        return {
          id,
          shortId: short.get(id)!,
          project: session.project,
          state: states[index]!,
          since: session.since,
          detail: detail(session, states[index]!),
        };
      }),
    };
  }
}
