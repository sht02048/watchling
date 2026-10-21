export type OrderInput = {
  key: string;
  predecessor: string | null;
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
  return inputs.flatMap((input) => {
    if (input.predecessor === null) return [];
    const predecessor = byKey.get(input.predecessor);
    const previousReceipt = admissions.get(input.predecessor) ?? null;
    const receipt = admissions.get(input.key) ?? null;
    const admissionOrder =
      previousReceipt === "ambiguous" || receipt === "ambiguous"
        ? "ambiguous"
        : previousReceipt === null || receipt === null
          ? "unobserved"
          : previousReceipt.receivedSeq < receipt.receivedSeq
            ? "ordered"
            : "reversed";
    const status =
      input.startedNs === null
        ? "input-unissued"
        : predecessor === undefined
          ? "predecessor-missing"
          : predecessor.startedNs === null
            ? "predecessor-unissued"
            : previousReceipt === "ambiguous" || receipt === "ambiguous"
              ? "admission-ambiguous"
              : previousReceipt === null || receipt === null
                ? "admission-missing"
                : previousReceipt.disposition === "overflow" ||
                    receipt.disposition === "overflow"
                  ? "not-admitted"
                  : admissionOrder;
    return [
      {
        key: input.key,
        predecessor: input.predecessor,
        status,
        inputReason: input.reason,
        predecessorReason: predecessor?.reason ?? null,
        stages: {
          preparation: compare(predecessor?.preparedNs, input.preparedNs),
          launch: compare(predecessor?.startedNs, input.startedNs),
          nativeCapture: compare(
            captured.get(input.predecessor)?.atNs,
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
      },
    ];
  });
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
