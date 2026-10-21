import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseOrder,
  diagnoseProducer,
  normalCorpusPredecessors,
  type OrderInput,
  type OrderReceipt,
  type ProducerTiming,
} from "../profiles/order.ts";

function input(key: string, predecessor: string | null): OrderInput {
  return {
    key,
    predecessors: predecessor === null ? [] : [predecessor],
    eventId: key,
    preparedNs: key === "a" ? "10" : "60",
    startedNs: key === "a" ? "11" : "61",
    forwardedNs: key === "a" ? "100" : "110",
    reason: null,
  };
}
function receipt(
  eventId: string,
  receivedSeq: number,
  atNs: string,
  disposition: OrderReceipt["disposition"] = "queued",
): OrderReceipt {
  return { eventId, receivedSeq, atNs, disposition };
}
function normalFixture(
  count: number,
  arrivals: Readonly<Record<number, number>> = {},
) {
  const inputs: OrderInput[] = Array.from({ length: count }, (_, index) => {
    const step = index % 20;
    const source = step === 18 ? index - 17 : step === 19 ? index - 12 : index;
    return {
      key: String(index),
      predecessors: normalCorpusPredecessors(index).map(String),
      eventId: String(source),
      preparedNs: String(index * 100),
      startedNs: String(index * 100 + 1),
      forwardedNs: null,
      reason: null,
    };
  });
  const receipts = inputs
    .map((entry, index) =>
      receipt(
        entry.eventId!,
        0,
        String(arrivals[index] ?? index * 100 + 50),
        index % 20 >= 18 ? "duplicate" : "queued",
      ),
    )
    .sort((a, b) => Number(a.atNs) - Number(b.atNs))
    .map((entry, index) => ({ ...entry, receivedSeq: index + 1 }));
  return { inputs, receipts };
}

test("normal corpus locks each operation and candidate wait pair, not independent tools", () => {
  const { inputs } = normalFixture(1200);
  assert.equal(
    inputs.reduce((total, entry) => total + entry.predecessors.length, 0),
    1612,
  );
  for (let block = 0; block < 60; block++) {
    const base = block * 20;
    const predecessors = (step: number) => inputs[base + step]!.predecessors;
    assert.deepEqual(
      predecessors(0),
      block < 8 ? [] : [String(base - 160 + 17)],
    );
    for (let step = 1; step <= 8; step++)
      assert.deepEqual(predecessors(step), [String(base)]);
    for (let tool = 0; tool < 6; tool++)
      assert.deepEqual(predecessors(11 + tool), [String(base + 1 + tool)]);
    assert.deepEqual(predecessors(9), [String(base + 8)]);
    assert.deepEqual(predecessors(10), [String(base + 7)]);
    assert.deepEqual(
      predecessors(17),
      [9, 10, 11, 12, 13, 14, 15, 16].map((step) => String(base + step)),
    );
    assert.deepEqual(predecessors(18), [String(base + 1)]);
    assert.deepEqual(predecessors(19), [String(base + 7)]);
  }
});

test("independent completions and replays may precede a delayed turn end", () => {
  const { inputs, receipts } = normalFixture(20, { 10: 1160, 17: 2050 });
  const diagnostics = diagnoseOrder(inputs, [], receipts);
  assert.ok(
    diagnostics.every(
      (e) => e.issuance === "ordered" && e.admission === "observed",
    ),
    JSON.stringify(diagnostics),
  );
  const sequence = (id: string, disposition: OrderReceipt["disposition"]) =>
    receipts.find((e) => e.eventId === id && e.disposition === disposition)!
      .receivedSeq;
  assert.ok(sequence("11", "queued") < sequence("10", "queued"));
  assert.ok(sequence("1", "duplicate") < sequence("17", "queued"));
});

test("exact replay requires an unambiguous prior source receipt", () => {
  const { inputs, receipts } = normalFixture(20, { 1: 1900 });
  const replay = diagnoseOrder(inputs, [], receipts).find(
    (e) => e.key === "18" && e.predecessor === "1",
  );
  assert.equal(replay?.issuance, "ordered");
  assert.equal(replay?.admission, "admission-ambiguous");
});

test("required tool and candidate wait issuance inversions fail", () => {
  for (const [open, close] of [
    [1, 11],
    [7, 10],
    [8, 9],
  ]) {
    const { inputs, receipts } = normalFixture(20);
    inputs[close!]!.startedNs = String(open! * 100);
    const failures = diagnoseOrder(inputs, [], receipts).filter(
      (e) => e.issuance !== "ordered",
    );
    assert.deepEqual(
      failures.map((e) => [e.predecessor, e.key, e.issuance]),
      [[String(open), String(close), "reversed"]],
    );
    assert.equal(failures[0]?.admission, "observed");
  }
});

test("turn end follows every issued close and the next same-root turn follows that end", () => {
  for (let close = 9; close <= 16; close++) {
    const { inputs, receipts } = normalFixture(20, { [close]: 1800 });
    inputs[close]!.startedNs = "1702";
    const failures = diagnoseOrder(inputs, [], receipts).filter(
      (e) => e.issuance !== "ordered",
    );
    assert.deepEqual(
      failures.map((e) => [e.predecessor, e.key, e.issuance]),
      [[String(close), "17", "reversed"]],
    );
  }
  const { inputs, receipts } = normalFixture(180, { 17: 16055 });
  inputs[17]!.startedNs = "16002";
  const failures = diagnoseOrder(inputs, [], receipts).filter(
    (e) => e.issuance !== "ordered",
  );
  assert.deepEqual(
    failures.map((e) => [e.predecessor, e.key, e.issuance]),
    [["17", "160", "reversed"]],
  );
});

test("unissued tool end fails its edge and turn boundary without invented inversions", () => {
  const { inputs, receipts } = normalFixture(20);
  inputs[12]!.startedNs = null;
  inputs[12]!.reason = "concurrency-limit";
  const failures = diagnoseOrder(
    inputs,
    [],
    receipts.filter((e) => e.eventId !== "12"),
  ).filter((e) => e.issuance !== "ordered");
  assert.deepEqual(
    failures.map((e) => [e.predecessor, e.key, e.issuance]),
    [
      ["2", "12", "input-unissued"],
      ["12", "17", "predecessor-unissued"],
    ],
  );
});

test("collector admission stays distinct from issuance and forwarding", () => {
  const [result] = diagnoseOrder(
    [input("a", null), input("b", "a")],
    [
      { key: "a", atNs: "80" },
      { key: "b", atNs: "90" },
    ],
    [receipt("a", 40, "85"), receipt("b", 41, "95")],
  );
  assert.equal(result?.issuance, "ordered");
  assert.equal(result?.admission, "observed");
  assert.equal(result?.stages.nativeCapture, "ordered");
  assert.deepEqual(
    result?.stages.collectorAdmission.predecessor,
    receipt("a", 40, "85"),
  );
  assert.equal(result?.stages.collectorAdmission.order, "ordered");
});

test("ordered issuance retains a genuine admission reversal without claiming semantic correctness", () => {
  const [result] = diagnoseOrder(
    [input("a", null), input("b", "a")],
    [
      { key: "a", atNs: "80" },
      { key: "b", atNs: "90" },
    ],
    [receipt("b", 40, "95"), receipt("a", 41, "96")],
  );
  assert.equal(result?.issuance, "ordered");
  assert.equal(result?.admission, "observed");
  assert.equal(result?.stages.launch, "ordered");
  assert.equal(result?.stages.nativeCapture, "ordered");
  assert.equal(result?.stages.collectorAdmission.order, "reversed");
});

test("ordered admission cannot hide reversed causal issuance", () => {
  const [result] = diagnoseOrder(
    [{ ...input("a", null), startedNs: "70" }, input("b", "a")],
    [],
    [receipt("a", 1, "85"), receipt("b", 2, "95")],
  );
  assert.equal(result?.issuance, "reversed");
  assert.equal(result?.admission, "observed");
  assert.equal(result?.stages.collectorAdmission.order, "ordered");
});

test("missing and unissued predecessors remain failed evidence", () => {
  assert.equal(
    diagnoseOrder([input("b", "a")], [], [receipt("b", 1, "95")])[0]?.issuance,
    "predecessor-missing",
  );
  const [result] = diagnoseOrder(
    [
      { ...input("a", null), startedNs: null, reason: "missed-absolute-slot" },
      input("b", "a"),
    ],
    [],
    [receipt("b", 1, "95")],
  );
  assert.equal(result?.issuance, "predecessor-unissued");
  assert.equal(result?.admission, "admission-missing");
  assert.equal(result?.predecessorReason, "missed-absolute-slot");
  assert.equal(
    diagnoseOrder(
      [input("a", null), { ...input("b", "a"), startedNs: null }],
      [],
      [],
    )[0]?.issuance,
    "input-unissued",
  );
});

test("capture and forwarding do not substitute for admission", () => {
  const [result] = diagnoseOrder(
    [input("a", null), input("b", "a")],
    [
      { key: "a", atNs: "80" },
      { key: "b", atNs: "90" },
    ],
    [],
  );
  assert.equal(result?.admission, "admission-missing");
  assert.equal(result?.stages.forwardingCompleted, "ordered");
  assert.equal(result?.stages.collectorAdmission.order, "unobserved");
  assert.equal(
    diagnoseOrder(
      [input("a", null), input("b", "a")],
      [],
      [receipt("b", 1, "95")],
    )[0]?.admission,
    "admission-missing",
  );
});

test("forward completion can reverse while admission and issuance remain ordered", () => {
  const [result] = diagnoseOrder(
    [{ ...input("a", null), forwardedNs: "120" }, input("b", "a")],
    [],
    [receipt("a", 1, "85"), receipt("b", 2, "95")],
  );
  assert.equal(result?.issuance, "ordered");
  assert.equal(result?.admission, "observed");
  assert.equal(result?.stages.forwardingCompleted, "reversed");
});

test("nonoverlapping exact replays retain identity without FIFO assumptions", () => {
  const replay = { ...input("b", "a"), eventId: "a" };
  const [result] = diagnoseOrder(
    [input("a", null), replay],
    [],
    [receipt("a", 1, "40"), receipt("a", 2, "95", "duplicate")],
  );
  assert.equal(result?.issuance, "ordered");
  assert.equal(result?.admission, "observed");
  assert.deepEqual(
    result?.stages.collectorAdmission.current,
    receipt("a", 2, "95", "duplicate"),
  );
  const [ambiguous] = diagnoseOrder(
    [input("a", null), replay],
    [],
    [receipt("a", 1, "85"), receipt("a", 2, "95", "duplicate")],
  );
  assert.equal(ambiguous?.admission, "admission-ambiguous");
  assert.equal(
    diagnoseOrder([input("a", null), replay], [], [receipt("a", 1, "40")])[0]
      ?.admission,
    "admission-ambiguous",
  );
});

test("authenticated overflow is not admission", () => {
  assert.equal(
    diagnoseOrder(
      [input("a", null), input("b", "a")],
      [],
      [receipt("a", 1, "85"), receipt("b", 2, "95", "overflow")],
    )[0]?.admission,
    "not-admitted",
  );
});

test("producer diagnostics distinguish late wake, preparation and dispatch blocking", () => {
  const previous: ProducerTiming = {
    index: 0,
    scheduledMs: 0,
    wokeMs: 0.2,
    preparationStartedMs: 0.2,
    preparedMs: 0.3,
    decisionMs: 0.4,
    startedMs: 0.5,
    dispatchReturnedMs: 12,
    reason: null,
  };
  const missed: ProducerTiming = {
    index: 1,
    scheduledMs: 5,
    wokeMs: 12.1,
    preparationStartedMs: 12.1,
    preparedMs: 12.2,
    decisionMs: 12.3,
    startedMs: null,
    dispatchReturnedMs: null,
    reason: "missed-absolute-slot",
  };
  const [late] = diagnoseProducer([previous, missed], 5);
  assert.equal(late?.cause, "late-wake");
  assert.equal(late?.previousDispatch?.synchronousMs, 11.5);
  assert.equal(
    diagnoseProducer(
      [{ ...missed, wokeMs: 5.2, preparationStartedMs: 5.3 }],
      5,
    )[0]?.cause,
    "preparation-overrun",
  );
  assert.equal(
    diagnoseProducer(
      [{ ...missed, wokeMs: 5.2, preparationStartedMs: 5.3, preparedMs: 5.4 }],
      5,
    )[0]?.cause,
    "decision-overrun",
  );
  assert.deepEqual(diagnoseProducer([previous], 5), []);
});
