export const semanticStates = [
  "idle",
  "working",
  "attention",
  "unknown",
] as const;
export type SemanticState = (typeof semanticStates)[number];

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
}

export interface Point {
  x: number;
  y: number;
}

export interface PetBridge {
  getSnapshot(): Promise<Snapshot>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
  onCursor(listener: (point: Point) => void): () => void;
  setPetHit(hit: boolean): void;
  beginDrag(): void;
  endDrag(): void;
  openSessionList(): void;
  closeSessionList(): void;
}

declare global {
  interface Window {
    pagent: PetBridge;
  }
}
