import assert from "node:assert/strict";
import type { Snapshot } from "../shared/ui-contract.ts";

// Publication means send returned, not renderer acknowledgement. Bytes are unpublished bytes.
export type SnapshotAccounting = {
  windowId: number;
  kind: "scheduled" | "materialized" | "published" | "cancelled";
  pending: 0 | 1;
  bytes: number;
  atMs: number;
};

export interface SnapshotPublisherOptions {
  getSnapshot(): Snapshot;
  getTargets(): readonly { id: number; send(snapshot: Snapshot): void }[];
  onAccounting?: (record: SnapshotAccounting) => void;
  schedule?: (callback: () => void, delayMs: number) => () => void;
  now?: () => number;
}

interface Publication {
  // Only unpublished byte counts are retained, never snapshot contents.
  windows: Map<number, number>;
  cancelSchedule: (() => void) | undefined;
  flushing: boolean;
  cancelled: boolean;
  requested: boolean;
}

const maximumBytes = 128 * 1024;

export function createSnapshotPublisher(options: SnapshotPublisherOptions): {
  request(): void;
  cancel(): void;
  isPending(): boolean;
} {
  const now = options.now ?? (() => performance.now());
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });
  let pending: Publication | undefined;

  function account(
    publication: Publication,
    windowId: number,
    kind: SnapshotAccounting["kind"],
    bytes: number,
  ): void {
    const previous = publication.windows.has(windowId) ? 1 : 0;
    const count =
      previous + (kind === "scheduled" ? 1 : kind === "materialized" ? 0 : -1);
    assert(
      count === 0 || count === 1,
      "Each window may have at most one unpublished snapshot",
    );
    assert(
      kind !== "materialized" || previous === 1,
      "Materialization requires a scheduled snapshot",
    );
    if (count === 0) publication.windows.delete(windowId);
    else publication.windows.set(windowId, bytes);
    options.onAccounting?.({
      windowId,
      kind,
      pending: count,
      bytes,
      atMs: now(),
    });
  }

  function throwErrors(errors: unknown[]): void {
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, "Snapshot publication cleanup failed");
  }

  function discard(publication: Publication, errors: unknown[] = []): void {
    if (!publication.cancelled) {
      publication.cancelled = true;
      publication.requested = false;
      const stop = publication.cancelSchedule;
      publication.cancelSchedule = undefined;
      try {
        stop?.();
      } catch (error) {
        errors.push(error);
      }
      for (const windowId of publication.windows.keys()) {
        try {
          account(publication, windowId, "cancelled", 0);
        } catch (error) {
          errors.push(error);
        }
      }
      if (pending === publication) pending = undefined;
    }
    throwErrors(errors);
  }

  function targets(): Map<
    number,
    { id: number; send(snapshot: Snapshot): void }
  > {
    const result = new Map<
      number,
      { id: number; send(snapshot: Snapshot): void }
    >();
    for (const target of options.getTargets()) {
      assert(!result.has(target.id), "Snapshot target IDs must be unique");
      result.set(target.id, target);
    }
    return result;
  }

  function active(publication: Publication): boolean {
    return pending === publication && !publication.cancelled;
  }

  function reconcile(
    publication: Publication,
    current: ReturnType<typeof targets>,
  ): void {
    for (const windowId of publication.windows.keys()) {
      if (!active(publication)) return;
      if (!current.has(windowId))
        account(publication, windowId, "cancelled", 0);
    }
    for (const windowId of current.keys()) {
      if (!active(publication)) return;
      if (!publication.windows.has(windowId))
        account(publication, windowId, "scheduled", 0);
    }
  }

  function flush(publication: Publication): void {
    if (!active(publication)) return;
    publication.cancelSchedule = undefined;
    publication.flushing = true;
    try {
      const current = targets();
      reconcile(publication, current);
      if (!active(publication)) return;
      const snapshot = options.getSnapshot();
      if (!active(publication)) return;
      const bytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
      assert(
        bytes <= maximumBytes,
        "Snapshot exceeds the 128 KiB encoded payload limit",
      );
      for (const windowId of current.keys()) {
        if (!active(publication)) return;
        account(publication, windowId, "materialized", bytes);
      }
      for (const windowId of current.keys()) {
        if (!active(publication)) return;
        // A preceding send may have closed another window synchronously.
        const target = targets().get(windowId);
        if (!target) {
          account(publication, windowId, "cancelled", 0);
          continue;
        }
        target.send(snapshot);
        if (!active(publication)) return;
        account(publication, windowId, "published", 0);
      }
    } catch (error) {
      discard(publication, [error]);
      return;
    }
    if (!active(publication)) return;
    pending = undefined;
    // Reentrant requests after materialization belong to the next 50 ms batch.
    if (publication.requested) request();
  }

  function request(): void {
    if (pending) {
      if (pending.flushing && !pending.cancelled) pending.requested = true;
      return;
    }
    const publication: Publication = {
      windows: new Map(),
      cancelSchedule: undefined,
      flushing: false,
      cancelled: false,
      requested: false,
    };
    pending = publication;
    try {
      reconcile(publication, targets());
      if (!active(publication)) return;
      const stop = schedule(() => flush(publication), 50);
      if (active(publication)) publication.cancelSchedule = stop;
    } catch (error) {
      discard(publication, [error]);
    }
  }

  return {
    request,
    cancel: () => {
      if (pending) discard(pending);
    },
    isPending: () => pending !== undefined,
  };
}
