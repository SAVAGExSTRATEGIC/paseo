import { generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { describe, expect, test } from "vitest";
import { BrowserPassportVerifier, buildPassportMessage } from "./verifier.js";

const binding = {
  host: "SAVAGEs-MacBook-Pro.local",
  chromePath: "/Applications/Google Chrome.app",
  profileDirectory: "Profile 3",
};

function fixture(now = 1_000) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const verifier = new BrowserPassportVerifier({
    binding: {
      ...binding,
      publicKeySpkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    },
    now: () => now,
  });
  const clientId = "host-1";
  const challenge = verifier.issueChallenge(clientId);
  const signatureBase64 = sign("sha256", buildPassportMessage(challenge), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64");
  return { verifier, challenge, signatureBase64, clientId };
}

describe("BrowserPassportVerifier", () => {
  test("accepts Chrome compatible WebCrypto P-256 signatures", async () => {
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    const publicKeySpkiBase64 = Buffer.from(
      await webcrypto.subtle.exportKey("spki", pair.publicKey),
    ).toString("base64");
    const verifier = new BrowserPassportVerifier({
      binding: { ...binding, publicKeySpkiBase64 },
    });
    const challenge = verifier.issueChallenge("chrome-host");
    const signatureBase64 = Buffer.from(
      await webcrypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        buildPassportMessage(challenge),
      ),
    ).toString("base64");
    expect(
      verifier.verifyResponse({
        challengeId: challenge.id,
        clientId: "chrome-host",
        signatureBase64,
      }),
    ).toBe(true);
  });

  test("admits only a signed, pinned challenge and consumes it once", () => {
    const { verifier, challenge, signatureBase64, clientId } = fixture();
    expect(verifier.verifyResponse({ challengeId: challenge.id, clientId, signatureBase64 })).toBe(
      true,
    );
    expect(verifier.consumeVerifiedClient(clientId)).toBe(true);
    expect(verifier.consumeVerifiedClient(clientId)).toBe(false);
    expect(verifier.verifyResponse({ challengeId: challenge.id, clientId, signatureBase64 })).toBe(
      false,
    );
  });

  test("rejects a different profile key before admission", () => {
    const { verifier, challenge, clientId } = fixture();
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const signatureBase64 = sign("sha256", buildPassportMessage(challenge), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64");
    expect(verifier.verifyResponse({ challengeId: challenge.id, clientId, signatureBase64 })).toBe(
      false,
    );
    expect(verifier.consumeVerifiedClient(clientId)).toBe(false);
  });

  test("rejects a challenge after expiry", () => {
    let now = 1_000;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const verifier = new BrowserPassportVerifier({
      binding: {
        ...binding,
        publicKeySpkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      },
      now: () => now,
      challengeTtlMs: 100,
    });
    const clientId = "host-1";
    const challenge = verifier.issueChallenge(clientId);
    const signatureBase64 = sign("sha256", buildPassportMessage(challenge), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64");
    now = 1_101;
    expect(verifier.verifyResponse({ challengeId: challenge.id, clientId, signatureBase64 })).toBe(
      false,
    );
  });

  test("rejects client substitution and malformed signatures", () => {
    const { verifier, challenge, signatureBase64, clientId } = fixture();
    expect(
      verifier.verifyResponse({
        challengeId: challenge.id,
        clientId: "another-host",
        signatureBase64,
      }),
    ).toBe(false);
    expect(
      verifier.verifyResponse({ challengeId: challenge.id, clientId, signatureBase64: "bad!" }),
    ).toBe(false);
    expect(verifier.consumeVerifiedClient(clientId)).toBe(false);
  });

  test("a new challenge revokes prior admission and the older challenge", () => {
    const { verifier, challenge, signatureBase64, clientId } = fixture();
    expect(verifier.verifyResponse({ challengeId: challenge.id, clientId, signatureBase64 })).toBe(
      true,
    );
    verifier.issueChallenge(clientId);
    expect(verifier.consumeVerifiedClient(clientId)).toBe(false);
    expect(verifier.verifyResponse({ challengeId: challenge.id, clientId, signatureBase64 })).toBe(
      false,
    );
  });
});
