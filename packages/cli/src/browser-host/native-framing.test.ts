import { describe, expect, it } from "vitest";

import { encodeNativeMessage, NativeMessageDecoder } from "./native-framing.js";

describe("Chrome native messaging framing", () => {
  it("decodes fragmented and adjacent JSON frames", () => {
    const received: unknown[] = [];
    const decoder = new NativeMessageDecoder((message) => received.push(message));
    const first = encodeNativeMessage({ type: "passport.signature", signatureBase64: "abc" });
    const second = encodeNativeMessage({ type: "browser.result", requestId: "req-1", ok: true });
    decoder.push(first.subarray(0, 2));
    decoder.push(Buffer.concat([first.subarray(2), second]));
    decoder.finish();
    expect(received).toEqual([
      { type: "passport.signature", signatureBase64: "abc" },
      { type: "browser.result", requestId: "req-1", ok: true },
    ]);
  });

  it("rejects zero, oversized, malformed, and truncated frames", () => {
    const decoder = new NativeMessageDecoder(() => {});
    expect(() => decoder.push(Buffer.alloc(4))).toThrow("Invalid native browser message length");
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(32 * 1024 * 1024 + 1);
    expect(() => new NativeMessageDecoder(() => {}).push(oversized)).toThrow(
      "Invalid native browser message length",
    );
    const badJson = Buffer.from(encodeNativeMessage({ ok: true }));
    badJson[4] = 0xff;
    expect(() => new NativeMessageDecoder(() => {}).push(badJson)).toThrow();
    const partial = new NativeMessageDecoder(() => {});
    partial.push(encodeNativeMessage({ ok: true }).subarray(0, 5));
    expect(() => partial.finish()).toThrow("Truncated native browser message");
  });

  it("never emits a host to Chrome message above the one MiB limit", () => {
    expect(() => encodeNativeMessage({ payload: "x".repeat(1024 * 1024) })).toThrow(
      "Native browser message exceeds Chrome's output limit",
    );
  });
});
