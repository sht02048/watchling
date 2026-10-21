import { parentPort, threadId, workerData } from "node:worker_threads";
import type { Socket } from "node:net";
import { setMaxListeners } from "node:events";
import type { Endpoint } from "../../src/integration/claude/protocol.ts";
import { createProfileTrace } from "./trace.ts";
import {
  fixedLane,
  prepareWires,
  sendWire,
  udsContract,
  type UdsCommand,
  type UdsWorkerMessage,
} from "./uds-producer.ts";

const port = parentPort;
if (!port) throw new Error("The UDS producer requires a worker parent port");
const abort = new AbortController();
const trace = createProfileTrace();
setMaxListeners(udsContract.concurrency + 1, abort.signal);
const sockets = new Set<Socket>();
let running = false;
const post = (message: UdsWorkerMessage): void => port.postMessage(message);
const stopSockets = (): void => {
  for (const socket of sockets) socket.destroy();
};
try {
  const endpoint = workerData as Endpoint;
  const preparationStarted = process.hrtime.bigint();
  const frames = prepareWires(endpoint);
  port.on("message", (command: UdsCommand) => {
    if (command.type === "cancel") {
      abort.abort(new Error("UDS producer cancelled"));
      stopSockets();
      if (!running) {
        trace.close();
        port.close();
      }
      return;
    }
    if (command.type !== "start" || running) {
      abort.abort(new Error("Invalid UDS producer command"));
      stopSockets();
      post({
        type: "failed",
        error: "UDS producer must be armed exactly once",
      });
      if (!running) {
        trace.close();
        port.close();
      }
      return;
    }
    running = true;
    void (async () => {
      try {
        const start = BigInt(command.startNs);
        post({
          type: "armed",
          startNs: start.toString(),
          atNs: process.hrtime.bigint().toString(),
        });
        const lane = await fixedLane(
          udsContract.count,
          udsContract.intervalMs,
          udsContract.concurrency,
          start,
          (index) => {
            const frame = frames[index]!;
            return {
              role: frame.role,
              eventId: frame.eventId,
              bytes: frame.bytes.length,
              sha256: frame.sha256,
              run: () =>
                sendWire(
                  frame.bytes,
                  endpoint.socketPath,
                  sockets,
                  abort.signal,
                  trace.begin,
                ),
            };
          },
          abort.signal,
          undefined,
          trace.begin,
        );
        abort.signal.throwIfAborted();
        const completedNs = process.hrtime.bigint().toString();
        trace.close();
        post({
          type: "done",
          lane,
          completedNs,
          trace: trace.report(),
        });
      } catch (error) {
        post({
          type: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        stopSockets();
        trace.close();
        port.close();
      }
    })();
  });
  post({
    type: "ready",
    preparation: {
      elapsedMs: Number(process.hrtime.bigint() - preparationStarted) / 1e6,
      wireFrames: frames.length,
      retainedWireBytes: frames.reduce(
        (total, frame) => total + frame.bytes.length,
        0,
      ),
      readyNs: process.hrtime.bigint().toString(),
      threadId,
    },
  });
} catch (error) {
  post({
    type: "failed",
    error: error instanceof Error ? error.message : String(error),
  });
  stopSockets();
  trace.close();
  port.close();
}
