import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { z } from "zod";
import { SlackApi } from "./slack-api.js";

const EnvelopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello") }),
  z.object({ type: z.literal("disconnect"), reason: z.string() }),
  z.object({
    type: z.enum(["events_api", "interactive"]),
    envelope_id: z.string(),
    payload: z.unknown(),
  }),
]);
export interface SocketConsumer {
  accept(type: "events_api" | "interactive", payload: unknown, envelopeId: string): Promise<void>;
  state(connected: boolean): void;
  failure(code: string): void;
}

/** Acknowledges only after the consumer has committed intake or rejected it by policy. */
export async function runSocketMode(
  api: SlackApi,
  consumer: SocketConsumer,
  signal: AbortSignal,
): Promise<void> {
  let failures = 0;
  while (!signal.aborted) {
    try {
      const url = await api.openSocket();
      await socketConnection({ url, consumer, signal });
      failures = 0;
    } catch {
      if (signal.aborted) break;
      failures += 1;
      consumer.failure("slack_socket_disconnected");
    }
    consumer.state(false);
    const backoff = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
    try {
      await delay(backoff, undefined, { signal });
    } catch {
      if (!signal.aborted) throw new Error("Socket backoff failed");
    }
  }
}

interface ConnectionInput {
  url: string;
  consumer: SocketConsumer;
  signal: AbortSignal;
}
function socketConnection(input: ConnectionInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(input.url, { maxPayload: 256 * 1024, handshakeTimeout: 10_000 });
    let queue = Promise.resolve();
    let pongReceived = true;
    let failed = false;
    const stop = () => socket.close(1000);
    input.signal.addEventListener("abort", stop, { once: true });
    if (input.signal.aborted) stop();
    const heartbeat = setInterval(() => {
      if (!pongReceived) {
        socket.terminate();
        return;
      }
      pongReceived = false;
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, 15_000);
    socket.on("pong", () => {
      pongReceived = true;
    });
    socket.on("error", () => {
      failed = true;
      socket.terminate();
    });
    socket.on("close", () => {
      clearInterval(heartbeat);
      input.signal.removeEventListener("abort", stop);
      // Finish durable intake already received before releasing exclusive state ownership.
      queue.then(() => {
        if (failed && !input.signal.aborted) {
          reject(new Error("Slack socket error"));
          return undefined;
        }
        resolve();
        return undefined;
      }, reject);
    });
    socket.on("message", (frame) => {
      let raw: unknown;
      try {
        raw = JSON.parse(frame.toString());
      } catch {
        input.consumer.failure("invalid_socket_json");
        return;
      }
      const parsed = EnvelopeSchema.safeParse(raw);
      if (!parsed.success) {
        input.consumer.failure("unsupported_socket_envelope");
        return;
      }
      const envelope = parsed.data;
      if (envelope.type === "hello") {
        input.consumer.state(true);
        return;
      }
      if (envelope.type === "disconnect") {
        socket.close(1000);
        return;
      }
      queue = queue
        .then(async () => {
          await input.consumer.accept(envelope.type, envelope.payload, envelope.envelope_id);
          if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
          return undefined;
        })
        .catch(() => {
          input.consumer.failure("socket_intake_not_committed");
          // Closing leaves the unacknowledged envelope eligible for Slack's retry.
          socket.close(1011);
        });
    });
  });
}
