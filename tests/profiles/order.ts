export type OrderInput = {
  key: string;
  predecessors: readonly string[];
  eventId: string | null;
  preparedNs: string | null;
  startedNs: string | null;
  forwardedNs: string | null;
  reason: string | null;
};
export type OrderCapture = {
  key: string;
  atNs: string;
};
export type OrderReceipt = {
  eventId: string;
  receivedSeq: number;
  disposition: "queued" | "duplicate" | "overflow";
  atNs: string;
};
type Comparison = "ordered" | "reversed" | "unobserved";
type Admission = OrderReceipt | "ambiguous" | null;

// The approved N fixture has six parallel tools, two candidate wait pairs,
// a turn boundary, and two exact-envelope replays. These dependencies are
// fixture intent, not evidence of provider wait/clear semantics. Independent
// tools and replays need not arrive in their scheduled total order. Issuance
// validity and observed admission order are separate evidence boundaries.
const normalBlockPredecessors = [
  [],
  [0],
  [0],
  [0],
  [0],
  [0],
  [0],
  [0],
  [0],
  [8],
  [7],
  [1],
  [2],
  [3],
  [4],
  [5],
  [6],
  [9, 10, 11, 12, 13, 14, 15, 16],
  [1],
  [7],
] as const;

export function normalCorpusPredecessors(index: number): number[] {
  const step = index % 20;
  const blockStart = index - step;
  // Blocks are round-robin across eight roots. The next turn on a root must
  // follow that root's prior turn end, not the preceding unrelated block.
  if (step === 0 && blockStart >= 8 * 20) return [blockStart - 8 * 20 + 17];
  return normalBlockPredecessors[step]!.map(
    (predecessor) => blockStart + predecessor,
  );
}

function compare(
  predecessor: string | null | undefined,
  current: string | null | undefined,
): Comparison {
  if (predecessor == null || current == null) return "unobserved";
  return BigInt(predecessor) < BigInt(current) ? "ordered" : "reversed";
}

export function diagnoseOrder(
  inputs: readonly OrderInput[],
  captures: readonly OrderCapture[],
  receipts: readonly OrderReceipt[],
) {
  const byKey = new Map(inputs.map((input) => [input.key, input]));
  const captured = new Map(captures.map((capture) => [capture.key, capture]));
  const admissions = new Map<string, Admission>();
  const inputsById = new Map<string, OrderInput[]>();
  const receiptsById = new Map<string, OrderReceipt[]>();
  for (const input of inputs) {
    if (input.eventId === null || input.startedNs === null) continue;
    const group = inputsById.get(input.eventId) ?? [];
    group.push(input);
    inputsById.set(input.eventId, group);
  }
  for (const receipt of receipts) {
    const group = receiptsById.get(receipt.eventId) ?? [];
    group.push(receipt);
    receiptsById.set(receipt.eventId, group);
  }
  for (const [id, group] of inputsById) {
    group.sort((a, b) =>
      BigInt(a.startedNs!) < BigInt(b.startedNs!) ? -1 : 1,
    );
    const observed = [...(receiptsById.get(id) ?? [])].sort(
      (a, b) => a.receivedSeq - b.receivedSeq,
    );
    // Identical replay bytes do not carry a per-send identity. Attribution is
    // proven only when every preceding receipt arrived before the next launch.
    // Never pair overlapping sends with receipts merely by launch-order FIFO.
    const ambiguous =
      group.length > 1 &&
      (observed.length !== group.length ||
        group.some((input, index) => {
          const receipt = observed[index];
          const next = group[index + 1];
          return (
            !receipt ||
            BigInt(receipt.atNs) < BigInt(input.startedNs!) ||
            (next !== undefined &&
              BigInt(receipt.atNs) >= BigInt(next.startedNs!))
          );
        }));
    for (const [index, input] of group.entries()) {
      const receipt = observed[index];
      admissions.set(
        input.key,
        ambiguous || observed.length > group.length
          ? "ambiguous"
          : receipt && BigInt(receipt.atNs) >= BigInt(input.startedNs!)
            ? receipt
            : null,
      );
    }
  }
  return inputs.flatMap((input) =>
    input.predecessors.map((predecessorKey) => {
      const predecessor = byKey.get(predecessorKey);
      const previousReceipt = admissions.get(predecessorKey) ?? null;
      const receipt = admissions.get(input.key) ?? null;
      const admissionOrder =
        previousReceipt === "ambiguous" || receipt === "ambiguous"
          ? "ambiguous"
          : previousReceipt === null || receipt === null
            ? "unobserved"
            : previousReceipt.receivedSeq < receipt.receivedSeq
              ? "ordered"
              : "reversed";
      const issuance =
        input.startedNs === null
          ? "input-unissued"
          : predecessor === undefined
            ? "predecessor-missing"
            : predecessor.startedNs === null
              ? "predecessor-unissued"
              : compare(predecessor.startedNs, input.startedNs);
      const admission =
        previousReceipt === "ambiguous" || receipt === "ambiguous"
          ? "admission-ambiguous"
          : previousReceipt === null || receipt === null
            ? "admission-missing"
            : previousReceipt.disposition === "overflow" ||
                receipt.disposition === "overflow"
              ? "not-admitted"
              : "observed";
      return {
        key: input.key,
        predecessor: predecessorKey,
        issuance,
        admission,
        inputReason: input.reason,
        predecessorReason: predecessor?.reason ?? null,
        stages: {
          preparation: compare(predecessor?.preparedNs, input.preparedNs),
          launch: compare(predecessor?.startedNs, input.startedNs),
          nativeCapture: compare(
            captured.get(predecessorKey)?.atNs,
            captured.get(input.key)?.atNs,
          ),
          forwardingCompleted: compare(
            predecessor?.forwardedNs,
            input.forwardedNs,
          ),
          collectorAdmission: {
            order: admissionOrder,
            predecessor: previousReceipt,
            current: receipt,
          },
        },
      };
    }),
  );
}

export type ProducerTiming = {
  index: number;
  scheduledMs: number;
  wokeMs: number;
  preparationStartedMs: number;
  preparedMs: number;
  decisionMs: number;
  dispatchReturnedMs: number | null;
  startedMs: number | null;
  reason: string | null;
};

export function diagnoseProducer(
  attempts: readonly ProducerTiming[],
  intervalMs: number,
) {
  return attempts.flatMap((attempt, index) => {
    if (attempt.reason !== "missed-absolute-slot") return [];
    const previous = attempts[index - 1];
    return [
      {
        index: attempt.index,
        scheduledMs: attempt.scheduledMs,
        wakeDelayMs: attempt.wokeMs - attempt.scheduledMs,
        preparationMs: attempt.preparedMs - attempt.preparationStartedMs,
        decisionDelayMs: attempt.decisionMs - attempt.scheduledMs,
        cause:
          attempt.wokeMs - attempt.scheduledMs >= intervalMs
            ? "late-wake"
            : attempt.preparedMs - attempt.scheduledMs >= intervalMs
              ? "preparation-overrun"
              : "decision-overrun",
        previousDispatch: previous
          ? {
              index: previous.index,
              startedMs: previous.startedMs,
              returnedMs: previous.dispatchReturnedMs,
              synchronousMs:
                previous.startedMs === null ||
                previous.dispatchReturnedMs === null
                  ? null
                  : previous.dispatchReturnedMs - previous.startedMs,
            }
          : null,
      },
    ];
  });
}
