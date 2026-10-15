import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";

export interface BrowserPassportBinding {
  host: string;
  chromePath: string;
  profileDirectory: string;
  publicKeySpkiBase64: string;
}

export interface BrowserPassportChallenge {
  id: string;
  nonce: string;
  clientId: string;
  host: string;
  chromePath: string;
  profileDirectory: string;
  expiresAt: number;
}

export interface BrowserPassportVerifierOptions {
  binding: BrowserPassportBinding;
  now?: () => number;
  challengeTtlMs?: number;
}

const DEFAULT_CHALLENGE_TTL_MS = 30_000;
const MAX_PENDING_CHALLENGES = 16;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function buildPassportMessage(challenge: BrowserPassportChallenge): Buffer {
  return Buffer.from(
    JSON.stringify([
      "paseo-browser-passport-v1",
      challenge.id,
      challenge.nonce,
      challenge.clientId,
      challenge.host,
      challenge.chromePath,
      challenge.profileDirectory,
      challenge.expiresAt,
    ]),
    "utf8",
  );
}

export class BrowserPassportVerifier {
  private readonly binding: BrowserPassportBinding;
  private readonly publicKey: ReturnType<typeof createPublicKey>;
  private readonly now: () => number;
  private readonly challengeTtlMs: number;
  private readonly pending = new Map<string, BrowserPassportChallenge>();
  private readonly verifiedClients = new Set<string>();

  public constructor(options: BrowserPassportVerifierOptions) {
    this.binding = options.binding;
    this.now = options.now ?? Date.now;
    this.challengeTtlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
    if (!Number.isSafeInteger(this.challengeTtlMs) || this.challengeTtlMs <= 0) {
      throw new Error("Browser passport challenge TTL is invalid");
    }
    const keyBytes = Buffer.from(options.binding.publicKeySpkiBase64, "base64");
    this.publicKey = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
    if (this.publicKey.asymmetricKeyType !== "ec") {
      throw new Error("Browser passport key must be an EC public key");
    }
    if (this.publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("Browser passport key must use P-256");
    }
  }

  public issueChallenge(clientId: string): BrowserPassportChallenge {
    for (const [id, challenge] of this.pending) {
      if (challenge.expiresAt < this.now() || challenge.clientId === clientId) {
        this.pending.delete(id);
      }
    }
    this.verifiedClients.delete(clientId);
    if (!clientId || this.pending.size >= MAX_PENDING_CHALLENGES) {
      throw new Error("Browser passport challenge unavailable");
    }
    const challenge: BrowserPassportChallenge = {
      id: randomUUID(),
      nonce: randomBytes(32).toString("base64url"),
      clientId,
      host: this.binding.host,
      chromePath: this.binding.chromePath,
      profileDirectory: this.binding.profileDirectory,
      expiresAt: this.now() + this.challengeTtlMs,
    };
    this.pending.set(challenge.id, challenge);
    return challenge;
  }

  public verifyResponse(input: {
    challengeId: string;
    clientId: string;
    signatureBase64: string;
  }): boolean {
    const challenge = this.pending.get(input.challengeId);
    if (!challenge) return false;
    this.pending.delete(input.challengeId);
    this.verifiedClients.delete(input.clientId);
    if (challenge.clientId !== input.clientId || this.now() > challenge.expiresAt) return false;
    if (input.signatureBase64.length > 88 || !BASE64_PATTERN.test(input.signatureBase64))
      return false;
    const signature = Buffer.from(input.signatureBase64, "base64");
    if (signature.length !== 64) return false;
    const valid = verify(
      "sha256",
      buildPassportMessage(challenge),
      {
        key: this.publicKey,
        dsaEncoding: "ieee-p1363",
      },
      signature,
    );
    if (valid) this.verifiedClients.add(input.clientId);
    return valid;
  }

  public consumeVerifiedClient(clientId: string): boolean {
    return this.verifiedClients.delete(clientId);
  }
}
