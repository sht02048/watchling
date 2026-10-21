import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseOrder,
  diagnoseProducer,
  type OrderInput,
  type OrderReceipt,
  type ProducerTiming,
} from "../profiles/order.ts";

function input(key: string, predecessor: string | null): OrderInput {
  return {
    key,
    predecessor,
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

test("a slow predecessor is ordered by collector admission, not preparation or forwarding", () => {
  const [result] = diagnoseOrder(
    [input("a", null), input("b", "a")],
    [
      { key: "a", atNs: "80" },
      { key: "b", atNs: "90" },
    ],
    [receipt("a", 40, "85"), receipt("b", 41, "95")],
  );
  assert.equal(result?.status, "ordered");
  assert.equal(result?.stages.nativeCapture, "ordered");
  assert.deepEqual(
    result?.stages.collectorAdmission.predecessor,
    receipt("a", 40, "85"),
  );
  assert.equal(result?.stages.collectorAdmission.order, "ordered");
});

test("genuine admission reversal is not hidden by ordered launches or captures", () => {
  const [result] = diagnoseOrder(
    [input("a", null), input("b", "a")],
    [
      { key: "a", atNs: "80" },
      { key: "b", atNs: "90" },
    ],
    [receipt("b", 40, "95"), receipt("a", 41, "96")],
  );
  assert.equal(result?.status, "reversed");
  assert.equal(result?.stages.launch, "ordered");
  assert.equal(result?.stages.nativeCapture, "ordered");
  assert.equal(result?.stages.collectorAdmission.order, "reversed");
});

test("missing and unissued predecessors are incomplete evidence, not inverted delivery", () => {
  assert.equal(
    diagnoseOrder([input("b", "a")], [], [receipt("b", 1, "95")])[0]?.status,
    "predecessor-missing",
  );
  const unissued = {
    ...input("a", null),
    startedNs: null,
    reason: "missed-absolute-slot",
  };
  const [result] = diagnoseOrder(
    [unissued, input("b", "a")],
    [],
    [receipt("b", 1, "95")],
  );
  assert.equal(result?.status, "predecessor-unissued");
  assert.equal(result?.predecessorReason, "missed-absolute-slot");
  assert.equal(
    diagnoseOrder(
      [input("a", null), { ...input("b", "a"), startedNs: null }],
      [],
      [],
    )[0]?.status,
    "input-unissued",
  );
});

test("capture and completed socket forwarding do not substitute for admission", () => {
  const [result] = diagnoseOrder(
    [input("a", null), input("b", "a")],
    [
      { key: "a", atNs: "80" },
      { key: "b", atNs: "90" },
    ],
    [],
  );
  assert.equal(result?.status, "admission-missing");
  assert.equal(result?.stages.forwardingCompleted, "ordered");
  assert.equal(result?.stages.collectorAdmission.order, "unobserved");
  assert.equal(
    diagnoseOrder(
      [input("a", null), input("b", "a")],
      [],
      [receipt("b", 1, "95")],
    )[0]?.status,
    "admission-missing",
  );
});

test("forward completion can reverse while collector admission remains ordered", () => {
  const [result] = diagnoseOrder(
    [{ ...input("a", null), forwardedNs: "120" }, input("b", "a")],
    [],
    [receipt("a", 1, "85"), receipt("b", 2, "95")],
  );
  assert.equal(result?.status, "ordered");
  assert.equal(result?.stages.forwardingCompleted, "reversed");
});

test("nonoverlapping exact replay receipts retain identity without FIFO assumptions", () => {
  const replay = { ...input("b", "a"), eventId: "a" };
  const [result] = diagnoseOrder(
    [input("a", null), replay],
    [],
    [receipt("a", 1, "40"), receipt("a", 2, "95", "duplicate")],
  );
  assert.equal(result?.status, "ordered");
  assert.deepEqual(
    result?.stages.collectorAdmission.current,
    receipt("a", 2, "95", "duplicate"),
  );
  const [ambiguous] = diagnoseOrder(
    [input("a", null), replay],
    [],
    [receipt("a", 1, "85"), receipt("a", 2, "95", "duplicate")],
  );
  assert.equal(ambiguous?.status, "admission-ambiguous");
  assert.equal(
    diagnoseOrder([input("a", null), replay], [], [receipt("a", 1, "40")])[0]
      ?.status,
    "admission-ambiguous",
  );
});

test("authenticated overflow is not collector admission", () => {
  assert.equal(
    diagnoseOrder(
      [input("a", null), input("b", "a")],
      [],
      [receipt("a", 1, "85"), receipt("b", 2, "95", "overflow")],
    )[0]?.status,
    "not-admitted",
  );
});

test("producer diagnostics distinguish late wake, preparation, and dispatch blocking", () => {
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
