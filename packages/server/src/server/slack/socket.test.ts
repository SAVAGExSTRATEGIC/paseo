import { once } from "node:events";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { runSocketMode, type SocketConsumer } from "./socket.js";

async function fixture(hello: unknown) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing server address");
  server.on("connection", (socket) => socket.send(JSON.stringify(hello)));
  const states: boolean[] = [];
  const accepted: string[] = [];
  const controller = new AbortController();
  const consumer: SocketConsumer = {
    appId: "A1",
    state(connected) {
      states.push(connected);
    },
    failure() {},
    async accept(_type, _payload, id) {
      accepted.push(id);
    },
  };
  const api = {
    async openSocket() {
      return `ws://127.0.0.1:${address.port}`;
    },
  };
  const run = runSocketMode(api, consumer, controller.signal);
  return { server, controller, states, accepted, run };
}

it.each([
  { type: "hello", connection_info: { app_id: "A2" } },
  { type: "hello" },
  { type: "events_api", envelope_id: "early", payload: {} },
])(
  "permanently rejects a foreign or missing Socket Mode identity before consuming events: %j",
  async (hello) => {
    const f = await fixture(hello);
    try {
      await expect(f.run).rejects.toThrow("slack_socket_identity");
      expect(f.states).not.toContain(true);
      expect(f.accepted).toEqual([]);
    } finally {
      f.controller.abort();
      await new Promise<void>((resolve, reject) =>
        f.server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }),
      );
    }
  },
);

it("acknowledges committed events after the configured app's hello", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("Missing server address");
  const controller = new AbortController();
  const receipt = new Promise<string>((resolve) =>
    server.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "hello", connection_info: { app_id: "A1" } }));
      socket.send(JSON.stringify({ type: "events_api", envelope_id: "event1", payload: {} }));
      socket.once("message", (frame) => resolve(frame.toString()));
    }),
  );
  let committed = false;
  const states: boolean[] = [];
  const run = runSocketMode(
    {
      async openSocket() {
        return `ws://127.0.0.1:${address.port}`;
      },
    },
    {
      appId: "A1",
      state(connected) {
        states.push(connected);
      },
      failure() {},
      async accept() {
        committed = true;
      },
    },
    controller.signal,
  );
  try {
    expect(JSON.parse(await receipt)).toEqual({ envelope_id: "event1" });
    expect(committed).toBe(true);
    expect(states).toContain(true);
  } finally {
    controller.abort();
    await run;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }),
    );
  }
});
