import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBrowserToolsBrokerAtStartup, loadBrowserPassportAtStartup } from "./binding.js";

const homes: string[] = [];
const expected = {
  expectedHost: "test-host",
  expectedChromePath: "/Applications/Google Chrome.app",
  expectedProfileDirectory: "Profile 3",
  extensionOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
};

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function createHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-browser-passport-"));
  homes.push(home);
  return home;
}

function writeBinding(home: string, changes: Record<string, unknown> = {}): void {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  writeFileSync(
    path.join(home, "browser-passport.json"),
    JSON.stringify({
      version: 1,
      host: expected.expectedHost,
      chromePath: expected.expectedChromePath,
      profileDirectory: expected.expectedProfileDirectory,
      extensionOrigin: expected.extensionOrigin,
      publicKeySpkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      ...changes,
    }),
  );
}

describe("browser passport startup", () => {
  it("keeps optional generic browser hosting unchanged", () => {
    expect(loadBrowserPassportAtStartup({ paseoHome: createHome(), required: false })).toEqual({
      required: false,
      state: "unrestricted",
    });
  });

  it("fails closed when pairing is missing, invalid, or for another host/profile", () => {
    const home = createHome();
    const load = () =>
      loadBrowserPassportAtStartup({ paseoHome: home, required: true, ...expected });
    expect(load()).toEqual({ required: true, state: "awaiting_pairing" });
    writeFileSync(path.join(home, "browser-passport.json"), "not-json");
    expect(load()).toEqual({ required: true, state: "awaiting_pairing" });
    writeBinding(home, { profileDirectory: "Default" });
    expect(load()).toEqual({ required: true, state: "awaiting_pairing" });
    writeBinding(home, { host: "other-host" });
    expect(load()).toEqual({ required: true, state: "awaiting_pairing" });
    writeBinding(home, { extensionOrigin: "chrome-extension://wrong/" });
    expect(load()).toEqual({ required: true, state: "awaiting_pairing" });
    writeBinding(home, { publicKeySpkiBase64: "not-a-key" });
    expect(load()).toEqual({ required: true, state: "awaiting_pairing" });
  });

  it("denies browser host registration before pairing", () => {
    const broker = createBrowserToolsBrokerAtStartup({ paseoHome: createHome(), required: true });
    expect(() =>
      broker.registerClient({
        id: "unpaired",
        hostKind: "desktop app",
        supportedCommands: ["list_tabs"],
        sendBrowserAutomationRequest: () => {},
      }),
    ).toThrow("Browser host admission failed");
    expect(broker.getRegisteredClientCount()).toBe(0);
  });

  it("loads a matching public key for signed host admission", () => {
    const home = createHome();
    writeBinding(home);
    expect(
      loadBrowserPassportAtStartup({ paseoHome: home, required: true, ...expected }),
    ).toMatchObject({ required: true, state: "paired", verifier: expect.any(Object) });
  });
});
