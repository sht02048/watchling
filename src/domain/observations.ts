import type { ClaudeEvent } from "../integration/claude/protocol.ts";
import type { Snapshot } from "../shared/ui-contract.ts";

// A received hook candidate is not proof that the user is currently being asked.
// This observation boundary stays unknown until provider wait/clear coverage is verified.
export class Observations {
  private readonly projects = new Map<string, string>();
  private integrityLost = false;

  receive(event: ClaudeEvent): void {
    if (event.eventName === "SessionEnd" && !event.agentId) {
      this.projects.delete(event.sessionId);
      return;
    }
    if (event.agentId && !this.projects.has(event.sessionId)) return;
    if (!this.projects.has(event.sessionId) && this.projects.size >= 128) {
      this.integrityLost = true;
      return;
    }
    this.projects.set(event.sessionId, event.project);
  }

  loseIntegrity(): void {
    this.integrityLost = true;
  }

  snapshot(): Snapshot {
    const ids = [...this.projects.keys()];
    const reason = this.integrityLost
      ? "수신 누락이 감지되어 현재 상태를 확인할 수 없어요."
      : "신호는 수신했지만 실제 대기·해제 경로 검증은 아직 완료되지 않았어요.";
    return {
      state: "unknown",
      observation: this.integrityLost
        ? "이 실행의 관찰 신뢰가 저하됐어요. 수신 재개만으로 복구됐다고 판단하지 않아요."
        : ids.length > 0
          ? "현재 실행 이후 수신한 세션이에요. 대기 여부는 아직 검증되지 않았어요."
          : "아직 Claude Code 신호를 수신하지 않았어요.",
      sessions: ids.map((id) => {
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
          project: this.projects.get(id)!,
          state: "unknown",
          reason,
        };
      }),
    };
  }
}
