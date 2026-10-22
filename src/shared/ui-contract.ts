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
  background: "백그라운드",
  working: "작업 중",
  unknown: "확인 불가",
  asking: "확인 요청",
};

export interface SessionSummary {
  id: string;
  project: string;
  state: SemanticState;
  reason: string;
}

export interface Snapshot {
  state: SemanticState;
  sessions: readonly SessionSummary[];
  observation: string;
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
  setPetHit(hit: boolean): void;
  beginDrag(cursor: Point): void;
  endDrag(): void;
  openSessionList(): void;
  closeSessionList(): void;
}

declare global {
  interface Window {
    pagent: PetBridge;
  }
}
