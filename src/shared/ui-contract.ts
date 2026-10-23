export const semanticStates = [
  "idle",
  "background",
  "working",
  "unknown",
  "asking",
] as const;
export type SemanticState = (typeof semanticStates)[number];
export const stateLabels: Record<SemanticState, string> = {
  idle: "Idle",
  background: "Background",
  working: "Working",
  unknown: "Unknown",
  asking: "Asking",
};

export type SessionDetail =
  | { kind: "permission"; tool?: string }
  | { kind: "question" }
  | { kind: "tool"; tool: string }
  | { kind: "agents"; count: number };

export interface SessionSummary {
  id: string;
  shortId: string;
  project: string;
  state: SemanticState;
  since: number;
  detail: SessionDetail | null;
  focusable?: true;
  terminalName?: string;
}

export interface Snapshot {
  state: SemanticState;
  sessions: readonly SessionSummary[];
  companions: number;
}

export interface Point {
  x: number;
  y: number;
}

export function isPoint(value: unknown): value is Point {
  if (value === null || typeof value !== "object") return false;
  const point = value as Record<string, unknown>;
  return (
    Object.keys(point).length === 2 &&
    typeof point.x === "number" &&
    typeof point.y === "number" &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    Math.abs(point.x) <= 1_000_000 &&
    Math.abs(point.y) <= 1_000_000
  );
}

export interface PetBridge {
  getSnapshot(): Promise<Snapshot>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
  onCursor(listener: (point: Point) => void): () => void;
  onOpacity(listener: (opacity: number) => void): () => void;
  setPetHit(hit: boolean): void;
  beginDrag(cursor: Point): void;
  endDrag(): void;
  openSessionList(): void;
  showPetMenu(at: Point): void;
  closeSessionList(): void;
  copySessionId(id: string): void;
  focusSession(id: string): void;
  showSessionMenu(id: string): void;
}

declare global {
  interface Window {
    watchling: PetBridge;
  }
}
