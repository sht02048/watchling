(function () {
  const model = window.PagentModel;
  const $ = (id) => document.getElementById(id);
  const desktop = $("desktop"),
    anchor = $("pet-anchor"),
    petButton = $("pet-button");
  const popover = $("session-popover");
  const renderer = window.PagentPet.create($("pet-canvas"));
  const initialSessions = [
    {
      id: "a82f",
      project: "pagent",
      state: "attention",
      reason: "파일 변경 승인 요청",
    },
    {
      id: "b91c",
      project: "pagent",
      state: "working",
      reason: "질문 도구 · 방향 선택",
    },
    {
      id: "c13e",
      project: "minsug.me",
      state: "idle",
      reason: "명령 실행 승인 요청",
    },
  ];
  let sessions = initialSessions.map((session) => ({ ...session }));
  let selectedScenario = null;
  let isHidden = false;
  let position = null;
  let relativePosition = null;
  let drag = null;
  let suppressClick = false;
  const storageKey = "pagent.prototype.position.v1";
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (
      saved &&
      Number.isFinite(saved.x) &&
      Number.isFinite(saved.y) &&
      saved.x >= 0 &&
      saved.x <= 1 &&
      saved.y >= 0 &&
      saved.y <= 1
    )
      relativePosition = saved;
  } catch {
    /* The demo remains usable when browser storage is unavailable. */
  }
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS(svg.namespaceURI, "use");
    use.setAttribute("href", `#i-${name}`);
    svg.append(use);
    return svg;
  }
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  const controls = new Map();
  for (const session of sessions) {
    const row = node("div", "session-control");
    row.dataset.session = session.id;
    const badge = node("span", "session-icon");
    badge.append(icon("terminal"));
    const meta = node("label", "session-meta");
    meta.htmlFor = `session-${session.id}`;
    meta.append(
      node("strong", "", session.project),
      node("small", "", `#${session.id}`),
    );
    const select = document.createElement("select");
    select.id = `session-${session.id}`;
    select.setAttribute(
      "aria-label",
      `${session.project} #${session.id} 가상 세션 상태`,
    );
    for (const [value, info] of Object.entries(model.STATES)) {
      const option = node("option", "", info.short);
      option.value = value;
      select.append(option);
    }
    select.addEventListener("change", () => {
      sessions = model.updateSession(sessions, session.id, select.value);
      selectedScenario = null;
      update();
    });
    row.append(badge, meta, select);
    $("session-controls").append(row);
    controls.set(session.id, { row, select });
  }
  function renderWaiting() {
    const list = $("waiting-list");
    list.replaceChildren();
    const waiting = model.waiting(sessions);
    $("popover-title").textContent = waiting.length
      ? `당신을 기다리는 세션 ${waiting.length}`
      : "관찰한 세션";
    for (const session of waiting) {
      const row = node("div", "waiting-item");
      row.dataset.waiting = session.id;
      const badge = node("span", "session-icon");
      badge.append(icon("terminal"));
      const meta = node("div", "session-meta");
      meta.append(
        node("strong", "", session.project),
        node("small", "", `#${session.id}`),
        node("p", "waiting-reason", session.reason),
      );
      row.append(badge, meta);
      list.append(row);
    }
    const unknown = sessions.filter((session) => session.state === "unknown");
    if (unknown.length) {
      for (const session of unknown)
        list.append(
          node(
            "div",
            "unknown-item",
            `${session.project} #${session.id} · 상태 확인 불가`,
          ),
        );
    }
    if (!waiting.length)
      list.append(
        node(
          "p",
          "empty-list",
          unknown.length
            ? "현재 확인된 응답 대기는 없어요. 모르는 상태는 휴식으로 단정하지 않아요."
            : "지금은 당신을 기다리는 세션이 없어요. 하던 일에 집중해도 좋아요.",
        ),
      );
    if (!popover.hidden) positionPopover();
  }
  function update() {
    const state = model.aggregate(sessions),
      info = model.STATES[state];
    desktop.dataset.state = state;
    $("signal-readout").dataset.state = state;
    renderer.setState(state);
    $("state-label").textContent = info.label;
    $("state-description").textContent = info.description;
    $("state-code").textContent = state;
    const count = model.waiting(sessions).length;
    $("pet-count").hidden = count === 0;
    $("pet-count").textContent = String(count);
    updatePetLabel();
    for (const session of sessions) {
      const control = controls.get(session.id);
      control.row.dataset.state = session.state;
      control.select.value = session.state;
    }
    document
      .querySelectorAll("[data-scenario]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.scenario === selectedScenario),
        ),
      );
    renderWaiting();
  }
  function updatePetLabel() {
    const info = model.STATES[model.aggregate(sessions)];
    const count = model.waiting(sessions).length;
    petButton.setAttribute(
      "aria-label",
      `가시: ${info.label}. ${count ? `${count}개 세션 응답 대기. ` : ""}세션 목록 ${popover.hidden ? "열기" : "닫기"}`,
    );
  }
  document.querySelectorAll("[data-scenario]").forEach((button) =>
    button.addEventListener("click", () => {
      selectedScenario = button.dataset.scenario;
      sessions = sessions.map((session) => ({
        ...session,
        state: selectedScenario,
      }));
      update();
    }),
  );
  $("reset-demo").addEventListener("click", () => {
    sessions = initialSessions.map((session) => ({ ...session }));
    selectedScenario = null;
    setHidden(false);
    closePopover(false);
    resetPosition();
    update();
  });
  function closePopover(restoreFocus = true) {
    const wasOpen = !popover.hidden;
    popover.hidden = true;
    petButton.setAttribute("aria-expanded", "false");
    if (wasOpen && restoreFocus && !isHidden)
      petButton.focus({ preventScroll: true });
    updatePetLabel();
  }
  function togglePopover() {
    if (!popover.hidden) {
      closePopover();
      return;
    }
    popover.hidden = false;
    petButton.setAttribute("aria-expanded", "true");
    updatePetLabel();
    renderWaiting();
    positionPopover();
    $("close-popover").focus({ preventScroll: true });
  }
  $("close-popover").addEventListener("click", () => closePopover());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !popover.hidden) {
      event.preventDefault();
      closePopover();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (
      !popover.hidden &&
      !popover.contains(event.target) &&
      !anchor.contains(event.target)
    )
      closePopover(false);
  });
  petButton.addEventListener("click", (event) => {
    if (suppressClick && event.detail !== 0) {
      suppressClick = false;
      return;
    }
    suppressClick = false;
    togglePopover();
  });
  function size() {
    return anchor.offsetWidth;
  }
  function setPosition(x, y, remember = false) {
    const width = desktop.clientWidth,
      height = desktop.clientHeight,
      petSize = size();
    position = model.clampPosition(x, y, width, height, petSize);
    anchor.style.left = `${position.x}px`;
    anchor.style.top = `${position.y}px`;
    anchor.style.right = "auto";
    anchor.style.bottom = "auto";
    if (remember) {
      relativePosition = {
        x: width > petSize ? position.x / (width - petSize) : 0,
        y: height > petSize ? position.y / (height - petSize) : 0,
      };
      try {
        localStorage.setItem(storageKey, JSON.stringify(relativePosition));
      } catch {
        /* Storage is optional; movement is not. */
      }
    }
    if (!popover.hidden) positionPopover();
  }
  function layoutPosition() {
    const width = desktop.clientWidth,
      height = desktop.clientHeight,
      petSize = size();
    if (relativePosition)
      setPosition(
        relativePosition.x * Math.max(0, width - petSize),
        relativePosition.y * Math.max(0, height - petSize),
      );
    else setPosition(width - petSize - 12, height - petSize - 32);
  }
  function resetPosition() {
    relativePosition = null;
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* Restricted storage does not block reset. */
    }
    layoutPosition();
  }
  $("reset-position").addEventListener("click", resetPosition);
  function positionPopover() {
    if (popover.hidden || !position) return;
    const width = desktop.clientWidth,
      height = desktop.clientHeight;
    const left = Math.max(
      10,
      Math.min(
        width - popover.offsetWidth - 10,
        position.x + size() / 2 - popover.offsetWidth / 2,
      ),
    );
    const preferredTop = position.y - popover.offsetHeight + 25;
    const top = Math.max(
      35,
      Math.min(height - popover.offsetHeight - 8, preferredTop),
    );
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }
  petButton.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !position) return;
    drag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: position.x,
      y: position.y,
      moved: false,
    };
    suppressClick = false;
    petButton.setPointerCapture(event.pointerId);
  });
  petButton.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.startX,
      dy = event.clientY - drag.startY;
    if (Math.hypot(dx, dy) > 5) drag.moved = true;
    if (drag.moved) {
      closePopover(false);
      setPosition(drag.x + dx, drag.y + dy);
    }
  });
  function finishDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    suppressClick = drag.moved;
    if (drag.moved) setPosition(position.x, position.y, true);
    drag = null;
  }
  petButton.addEventListener("pointerup", finishDrag);
  petButton.addEventListener("pointercancel", finishDrag);
  petButton.addEventListener("lostpointercapture", finishDrag);
  petButton.addEventListener("keydown", (event) => {
    const directions = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    if (!directions[event.key]) return;
    event.preventDefault();
    closePopover(false);
    const [dx, dy] = directions[event.key],
      step = event.shiftKey ? 30 : 10;
    setPosition(position.x + dx * step, position.y + dy * step, true);
  });
  function setHidden(value) {
    isHidden = value;
    // Keep measured geometry while hiding so position is stable across resizes.
    anchor.style.visibility = value ? "hidden" : "visible";
    petButton.disabled = value;
    $("toggle-pet").querySelector("span").textContent = value
      ? "펫 다시 표시"
      : "펫 숨기기";
    $("toggle-pet").setAttribute("aria-pressed", String(value));
    if (value) closePopover(false);
  }
  $("toggle-pet").addEventListener("click", () => setHidden(!isHidden));
  const resizeObserver = new ResizeObserver(layoutPosition);
  resizeObserver.observe(desktop);
  resizeObserver.observe(anchor);
  window.addEventListener(
    "pagehide",
    () => {
      renderer.destroy();
      resizeObserver.disconnect();
    },
    { once: true },
  );
  // A bfcache restore needs fresh observers and animation state.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) window.location.reload();
  });
  layoutPosition();
  update();
})();
