/* Domain state belongs to the observer, never to a pet skin. */
(function (root) {
  const STATES = Object.freeze({
    idle: {
      label: "쉬고 있어요",
      short: "휴식",
      description: "지금은 기다리는 일이 없어요.",
      color: "#7e9982",
    },
    working: {
      label: "열심히 작업 중",
      short: "작업 중",
      description: "각자의 자리에서 일을 이어가고 있어요.",
      color: "#668fc1",
    },
    attention: {
      label: "당신을 기다려요",
      short: "응답 대기",
      description: "확인해 주면 다시 움직일 수 있어요.",
      color: "#c87542",
    },
    unknown: {
      label: "아직 알 수 없어요",
      short: "확인 불가",
      description: "관찰 신호를 기다리고 있어요. 오류는 아니에요.",
      color: "#8c839d",
    },
  });
  function assertState(state) {
    if (!Object.hasOwn(STATES, state))
      throw new RangeError(`Unknown state: ${state}`);
    return state;
  }
  function aggregate(sessions) {
    if (sessions.length === 0) return "unknown";
    const states = new Set(
      sessions.map((session) => assertState(session.state)),
    );
    return ["attention", "unknown", "working", "idle"].find((state) =>
      states.has(state),
    );
  }
  function updateSession(sessions, id, state) {
    assertState(state);
    if (!sessions.some((session) => session.id === id))
      throw new RangeError(`Unknown session: ${id}`);
    return sessions.map((session) =>
      session.id === id ? { ...session, state } : session,
    );
  }
  function waiting(sessions) {
    return sessions.filter((session) => session.state === "attention");
  }
  function clampPosition(x, y, width, height, size) {
    return {
      x: Math.max(0, Math.min(x, Math.max(0, width - size))),
      y: Math.max(0, Math.min(y, Math.max(0, height - size))),
    };
  }
  const api = Object.freeze({
    STATES,
    assertState,
    aggregate,
    updateSession,
    waiting,
    clampPosition,
  });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PagentModel = api;
})(globalThis);
