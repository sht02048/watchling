import { clsx } from "clsx";
import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { rgb } from "@watchling/renderer/pet/color.ts";
import { PALETTE } from "@watchling/renderer/pet/pet-figure.ts";
import {
  semanticStates,
  stateLabels,
  type SessionSummary,
  type Snapshot,
} from "@watchling/shared/ui-contract.ts";
import { Window } from "@/components/window/Window.tsx";
import styles from "./Sessions.module.css";

const rank = (session: SessionSummary) => semanticStates.indexOf(session.state);
const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;
const needYou = (count: number) => `${count} need${count === 1 ? "s" : ""} you`;

function summary(session: SessionSummary): string {
  const detail = session.detail;
  switch (session.state) {
    case "asking":
      return detail?.kind === "permission" && detail.tool
        ? `Approve ${detail.tool}`
        : "Needs approval";
    case "working":
      return detail?.kind === "tool" ? `Running ${detail.tool}` : "Working";
    case "background":
      return plural(
        detail?.kind === "agents" ? detail.count : 0,
        "background agent",
      );
    case "waiting":
      return `Waiting on ${plural(
        detail?.kind === "tasks" ? detail.count : 0,
        "background task",
      )}`;
    case "unknown":
      return "Missed signals";
    case "idle":
      return "Idle";
  }
}

function elapsed(since: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function useNow(interval: number): number {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((count) => count + 1), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return Date.now();
}

function Dot({ session }: { session: SessionSummary }) {
  return (
    <>
      <span
        className={styles.dot}
        style={{ background: rgb(PALETTE[session.state][1]) }}
        aria-hidden="true"
      />
      <span className="visually-hidden">{stateLabels[session.state]}:</span>
    </>
  );
}

function Row({
  session,
  label,
  now,
}: {
  session: SessionSummary;
  label: ReactNode;
  now: number;
}) {
  return (
    <li
      className={clsx(styles.row, session.state === "asking" && styles.asking)}
    >
      <Dot session={session} />
      {label}
      <span className={styles.detail}>{summary(session)}</span>
      <span className={styles.time}>{elapsed(session.since, now)}</span>
    </li>
  );
}

function SessionsList({ snapshot }: { snapshot: Snapshot }) {
  const now = useNow(1000);
  const sessions = [...snapshot.sessions].sort(
    (a, b) => rank(b) - rank(a) || b.since - a.since,
  );
  const asks = sessions.filter((session) => session.state === "asking").length;
  const projects = new Map<string, SessionSummary[]>();
  for (const session of sessions)
    projects.set(session.project, [
      ...(projects.get(session.project) ?? []),
      session,
    ]);

  return (
    <div className={styles.sessions}>
      <div className={styles.head}>
        <span>
          {sessions.length > 0
            ? plural(sessions.length, "session")
            : snapshot.state === "unknown"
              ? "Can't receive Claude Code signals"
              : "No sessions yet"}
        </span>
        <span className={styles.needs}>{asks > 0 ? needYou(asks) : ""}</span>
      </div>
      <ul className={styles.list} aria-label="Sessions">
        {[...projects].map(([project, group]) => {
          const lead = group[0]!;
          if (group.length === 1)
            return (
              <Row
                key={project}
                session={lead}
                now={now}
                label={<span className={styles.project}>{project}</span>}
              />
            );
          const waiting = group.filter(
            (session) => session.state === "asking",
          ).length;
          return (
            <li key={project}>
              <div
                className={clsx(
                  styles.row,
                  lead.state === "asking" && styles.asking,
                )}
              >
                <Dot session={lead} />
                <span className={styles.project}>
                  {project}
                  <span className="visually-hidden">, </span>
                  <span>{group.length}</span>
                  <span className="visually-hidden"> sessions</span>
                </span>
                <span className={styles.detail}>
                  {waiting > 0 ? needYou(waiting) : ""}
                </span>
                <span className={styles.time} />
              </div>
              <ul>
                {group.map((session) => (
                  <Row
                    key={session.id}
                    session={session}
                    now={now}
                    label={
                      <span className={styles.id}>{session.shortId}…</span>
                    }
                  />
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SessionsWindow({
  snapshot,
  open,
  onClose,
  elementRef,
  boundsRef,
  movable,
}: {
  snapshot: Snapshot;
  open: boolean;
  onClose: () => void;
  elementRef: RefObject<HTMLElement | null>;
  boundsRef: RefObject<HTMLElement | null>;
  movable: boolean;
}) {
  return (
    <Window
      title="Sessions"
      label="Watchling sessions"
      className={styles.window}
      barClassName={styles.bar}
      elementRef={elementRef}
      boundsRef={boundsRef}
      movable={movable}
      hidden={!open}
      onClose={onClose}
    >
      <SessionsList snapshot={snapshot} />
    </Window>
  );
}
