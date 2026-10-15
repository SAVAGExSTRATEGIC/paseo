import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildPassportMessage } from "../../../server/src/server/browser-tools/passport/verifier.js";
import { encodeNativeMessage, NativeMessageDecoder } from "./native-framing.js";
import { runNativeBrowserHost } from "./native-host.js";

const ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function pairing() {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-native-browser-"));
  homes.push(home);
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeySpkiBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  writeFileSync(
    path.join(home, "browser-passport.json"),
    JSON.stringify({
      version: 1,
      host: hostname(),
      chromePath: "/Applications/Google Chrome.app",
      profileDirectory: "Profile 3",
      extensionOrigin: ORIGIN,
      publicKeySpkiBase64,
    }),
  );
  return { home, privateKey, publicKeySpkiBase64 };
}

function outputQueue(output: PassThrough) {
  const queue: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  const decoder = new NativeMessageDecoder((message) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  output.on("data", (chunk: Buffer) => decoder.push(chunk));
  return {
    next(): Promise<unknown> {
      const message = queue.shift();
      return message === undefined
        ? new Promise((resolve) => waiters.push(resolve))
        : Promise.resolve(message);
    },
  };
}

describe("Chrome native browser host", () => {
  it("rejects another extension origin before daemon connection or tab access", async () => {
    const { home } = pairing();
    const connect = vi.fn();
    await expect(
      runNativeBrowserHost({
        home,
        callerOrigin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
        input: new PassThrough(),
        output: new PassThrough(),
        connect,
      }),
    ).rejects.toThrow("origin is not paired");
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects a different profile key before daemon connection", async () => {
    const { home } = pairing();
    const input = new PassThrough();
    const connect = vi.fn();
    const running = runNativeBrowserHost({
      home,
      callerOrigin: ORIGIN,
      input,
      output: new PassThrough(),
      connect,
    });
    input.write(
      encodeNativeMessage({
        type: "passport.hello",
        extensionOrigin: ORIGIN,
        publicKeySpkiBase64: "another-profile-key",
        supportedCommands: ["list_tabs", "new_tab", "navigate", "reload", "close_tab"],
      }),
    );
    await expect(running).rejects.toThrow("identity does not match pairing");
    expect(connect).not.toHaveBeenCalled();
  });

  it("relays a command only after signed admission and checks the response request ID", async () => {
    const { home, privateKey, publicKeySpkiBase64 } = pairing();
    const input = new PassThrough();
    const output = new PassThrough();
    const frames = outputQueue(output);
    const received = vi.fn();
    const release = vi.fn(async () => {});
    let onRequest: ((message: unknown) => void) | undefined;
    const challenge = {
      id: "challenge-1",
      nonce: "nonce-1",
      clientId: "client-1",
      host: hostname(),
      chromePath: "/Applications/Google Chrome.app",
      profileDirectory: "Profile 3",
      extensionOrigin: ORIGIN,
      expiresAt: Date.now() + 30_000,
    };
    const client = {
      requestBrowserHostChallenge: vi.fn(async () => challenge),
      registerBrowserHost: vi.fn(() => ({
        ready: Promise.resolve({}),
        subscribe: ({ update }: { update: (message: unknown) => void }) => {
          onRequest = update;
          return () => {};
        },
        release,
      })),
      subscribeConnectionStatus: (listener: (state: { status: string }) => void) => {
        listener({ status: "connected" });
        return () => {};
      },
      sendBrowserAutomationExecuteResponse: received,
      close: vi.fn(async () => {}),
    };
    const connect = vi.fn(async () => client) as unknown as Parameters<
      typeof runNativeBrowserHost
    >[0]["connect"];
    const running = runNativeBrowserHost({ home, callerOrigin: ORIGIN, input, output, connect });
    input.write(
      encodeNativeMessage({
        type: "passport.hello",
        extensionOrigin: ORIGIN,
        publicKeySpkiBase64,
        supportedCommands: ["list_tabs", "new_tab", "navigate", "reload", "close_tab"],
      }),
    );
    expect(await frames.next()).toMatchObject({ type: "passport.challenge" });
    expect(client.registerBrowserHost).not.toHaveBeenCalled();
    input.write(
      encodeNativeMessage({
        type: "passport.signature",
        challengeId: challenge.id,
        signatureBase64: sign("sha256", buildPassportMessage(challenge), {
          key: privateKey,
          dsaEncoding: "ieee-p1363",
        }).toString("base64"),
      }),
    );
    expect(await frames.next()).toEqual({ type: "passport.ready", challengeId: challenge.id });
    expect(client.registerBrowserHost).toHaveBeenCalledWith(
      expect.objectContaining({ passport: expect.objectContaining({ challengeId: challenge.id }) }),
    );

    onRequest?.({
      type: "browser.automation.execute.request",
      requestId: "req-1",
      command: { command: "list_tabs", args: {} },
    });
    expect(await frames.next()).toMatchObject({
      type: "browser.execute",
      request: { requestId: "req-1" },
    });
    const response = {
      type: "browser.automation.execute.response",
      payload: { requestId: "req-1", ok: true, result: { command: "list_tabs", tabs: [] } },
    };
    input.write(encodeNativeMessage({ type: "browser.result", response }));
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(response));
    input.end();
    await expect(running).rejects.toThrow("Chrome closed");
    expect(client.close).toHaveBeenCalled();
  });
});
