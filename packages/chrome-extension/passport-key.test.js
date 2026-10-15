import { webcrypto } from "node:crypto";

import { describe, expect, it } from "vitest";

import { BrowserPassportVerifier } from "../server/src/server/browser-tools/passport/verifier.js";
import { bytesToBase64, signChallenge } from "./passport-key.js";

describe("Chrome profile passport signing", () => {
  it("signs the exact daemon challenge with a nonextractable profile key", async () => {
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    expect(pair.privateKey.extractable).toBe(false);
    const publicKeySpkiBase64 = bytesToBase64(
      await webcrypto.subtle.exportKey("spki", pair.publicKey),
    );
    const verifier = new BrowserPassportVerifier({
      binding: {
        host: "test-host",
        chromePath: "/Applications/Google Chrome.app",
        profileDirectory: "Profile 3",
        extensionOrigin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
        publicKeySpkiBase64,
      },
    });
    const challenge = verifier.issueChallenge("native-browser-host");
    const signatureBase64 = await signChallenge(pair, challenge);
    expect(
      verifier.verifyResponse({
        challengeId: challenge.id,
        clientId: challenge.clientId,
        signatureBase64,
      }),
    ).toBe(true);
  });
});
