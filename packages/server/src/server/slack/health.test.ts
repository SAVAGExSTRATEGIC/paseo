import { expect, it } from "vitest";
import { serveHealth, type BridgeHealth } from "./health.js";

it("serves actual loopback liveness separately from Slack/Paseo readiness", async () => {
  const state: BridgeHealth = {
    release: "fixture",
    socketConnected: false,
    hostsReady: false,
    lastTickAt: Date.now(),
    pendingInputs: 2,
    pendingDeliveries: 3,
    needsAttention: 0,
  };
  const server = await serveHealth(0, () => ({ ...state }));
  const endpoint = `http://127.0.0.1:${server.port}`;
  try {
    expect((await fetch(`${endpoint}/healthz`)).status).toBe(200);
    expect((await fetch(`${endpoint}/readyz`)).status).toBe(503);
    state.socketConnected = true;
    expect((await fetch(`${endpoint}/readyz`)).status).toBe(503);
    state.hostsReady = true;
    const ready = await fetch(`${endpoint}/readyz`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      ready: true,
      live: true,
      release: "fixture",
      pendingInputs: 2,
    });
    state.lastTickAt = Date.now() - 20_000;
    expect((await fetch(`${endpoint}/healthz`)).status).toBe(503);
    expect((await fetch(`${endpoint}/readyz`, { method: "POST" })).status).toBe(404);
  } finally {
    await server.close();
  }
});
