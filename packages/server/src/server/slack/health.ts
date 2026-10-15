import { createServer } from "node:http";

export interface BridgeHealth {
  release: string;
  socketConnected: boolean;
  hostsReady: boolean;
  lastTickAt: number;
  pendingInputs: number;
  pendingDeliveries: number;
  needsAttention: number;
}

/** Loopback-only diagnostics contain counts and version, never conversation content. */
export async function serveHealth(
  port: number,
  snapshot: () => BridgeHealth,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.method !== "GET" || (request.url !== "/healthz" && request.url !== "/readyz")) {
      response.writeHead(404).end();
      return;
    }
    const state = snapshot();
    const live = Date.now() - state.lastTickAt < 15_000;
    const ready = live && state.socketConnected && state.hostsReady;
    response.writeHead((request.url === "/readyz" ? ready : live) ? 200 : 503, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify({ ...state, live, ready }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Health endpoint has no TCP address");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }),
      ),
  };
}
