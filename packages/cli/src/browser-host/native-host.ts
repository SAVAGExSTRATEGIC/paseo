import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { BrowserAutomationExecuteResponseSchema } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { readBrowserPassportBindingAtStartup } from "@getpaseo/server/browser-passport";
import { z } from "zod";

import { connectToDaemon } from "../utils/client.js";
import { encodeNativeMessage, NativeMessageDecoder } from "./native-framing.js";

const COMMANDS = ["list_tabs", "new_tab", "navigate", "reload", "close_tab"] as const;
const HelloSchema = z.object({
  type: z.literal("passport.hello"),
  extensionOrigin: z.string(),
  publicKeySpkiBase64: z.string(),
  supportedCommands: z.array(z.string()),
});
const SignatureSchema = z.object({
  type: z.literal("passport.signature"),
  challengeId: z.string(),
  signatureBase64: z.string(),
});
const ResultSchema = z.object({
  type: z.literal("browser.result"),
  response: BrowserAutomationExecuteResponseSchema,
});

class NativePort {
  private readonly queued: unknown[] = [];
  private readonly waiters: Array<{
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly decoder: NativeMessageDecoder;
  private closedError: Error | null = null;

  public constructor(
    input: Readable,
    private readonly output: Writable,
  ) {
    this.decoder = new NativeMessageDecoder((message) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(message);
      else this.queued.push(message);
    });
    input.on("data", (chunk: Buffer) => {
      try {
        this.decoder.push(chunk);
      } catch {
        this.close(new Error("Invalid native browser message"));
      }
    });
    input.on("end", () => this.close(new Error("Chrome closed the native browser connection")));
    input.on("error", () => this.close(new Error("Chrome native browser input failed")));
  }

  public send(message: unknown): void {
    if (this.closedError) throw this.closedError;
    this.output.write(encodeNativeMessage(message));
  }

  public next(timeoutMs?: number): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (this.queued.length > 0) return Promise.resolve(this.queued.shift());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      const timeout =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              const index = this.waiters.indexOf(waiter);
              if (index >= 0) this.waiters.splice(index, 1);
              reject(new Error("Chrome native browser response timed out"));
            }, timeoutMs);
      waiter.resolve = (value) => {
        if (timeout) clearTimeout(timeout);
        resolve(value);
      };
      waiter.reject = (error) => {
        if (timeout) clearTimeout(timeout);
        reject(error);
      };
    });
  }

  private close(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

export async function runNativeBrowserHost(options: {
  home: string;
  callerOrigin: string;
  input: Readable;
  output: Writable;
  connect?: typeof connectToDaemon;
}): Promise<void> {
  const binding = readBrowserPassportBindingAtStartup({ paseoHome: options.home });
  if (!binding || options.callerOrigin !== binding.extensionOrigin) {
    throw new Error("Browser passport origin is not paired");
  }
  const port = new NativePort(options.input, options.output);
  const hello = HelloSchema.parse(await port.next(5_000));
  if (
    hello.extensionOrigin !== binding.extensionOrigin ||
    hello.publicKeySpkiBase64 !== binding.publicKeySpkiBase64 ||
    hello.supportedCommands.length !== COMMANDS.length ||
    !COMMANDS.every((command) => hello.supportedCommands.includes(command))
  ) {
    throw new Error("Browser passport extension identity does not match pairing");
  }

  const connect = options.connect ?? connectToDaemon;
  const client: DaemonClient = await connect({
    target: { kind: "instance", home: options.home },
    clientId: `browser-${randomUUID()}`,
    clientType: "browser",
  });
  try {
    const challenge = await client.requestBrowserHostChallenge();
    port.send({ type: "passport.challenge", challenge });
    const signature = SignatureSchema.parse(await port.next(30_000));
    if (signature.challengeId !== challenge.id)
      throw new Error("Browser passport challenge changed");
    const observation = client.registerBrowserHost({
      hostKind: "chrome-extension",
      supportedCommands: [...COMMANDS],
      passport: {
        challengeId: challenge.id,
        signatureBase64: signature.signatureBase64,
      },
    });
    await observation.ready;
    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    const unsubscribe = observation.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type !== "browser.automation.execute.request") return;
        pending.set(
          message.requestId,
          setTimeout(() => pending.delete(message.requestId), 30_000),
        );
        port.send({ type: "browser.execute", request: message });
      },
    });
    let rejectDisconnect: (error: Error) => void = () => {};
    const disconnected = new Promise<never>((_resolve, reject) => {
      rejectDisconnect = reject;
    });
    const unsubscribeConnection = client.subscribeConnectionStatus((status) => {
      if (status.status !== "connected") {
        rejectDisconnect(new Error("Paseo daemon browser connection ended"));
      }
    });
    port.send({ type: "passport.ready", challengeId: challenge.id });

    try {
      for (;;) {
        const message = ResultSchema.parse(await Promise.race([port.next(), disconnected]));
        const requestId = message.response.payload.requestId;
        const timeout = pending.get(requestId);
        if (!timeout) throw new Error("Unexpected native browser response");
        clearTimeout(timeout);
        pending.delete(requestId);
        client.sendBrowserAutomationExecuteResponse(message.response);
      }
    } finally {
      unsubscribeConnection();
      unsubscribe();
      for (const timeout of pending.values()) clearTimeout(timeout);
      await observation.release().catch(() => {});
    }
  } finally {
    await client.close();
  }
}
