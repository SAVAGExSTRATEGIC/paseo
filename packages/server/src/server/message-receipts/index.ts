import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  AgentMessageAdmissionResultSchema,
  type AgentMessageAdmissionResult,
} from "@getpaseo/protocol/messages";

const AdmissionReceiptSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending"), fingerprint: z.string(), agentId: z.string() }),
  z.object({
    state: z.literal("resolved"),
    fingerprint: z.string(),
    agentId: z.string(),
    result: AgentMessageAdmissionResultSchema,
  }),
]);
interface AdmitMessageInput {
  agentId: string;
  messageId: string;
  request: unknown;
  admit: () => Promise<AgentMessageAdmissionResult>;
}
import { writeJsonFileAtomic } from "../atomic-file.js";

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(["pending", "completed"]),
  agentId: z.string(),
});
interface SendMessageInput {
  agentId: string;
  messageId: string;
  request: unknown;
  send: () => Promise<void>;
  prepare?: () => Promise<void>;
}

/** Owns message delivery receipts; creation is owned by CreationService. */
export class MessageReceipts {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly admissions = new Map<string, Promise<AgentMessageAdmissionResult>>();
  constructor(private readonly directory: string) {}

  admit(input: AdmitMessageInput): Promise<AgentMessageAdmissionResult> {
    const key = digest(["admit", input.agentId, input.messageId]);
    const previous = this.admissions.get(key);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.admitOnce(key, input),
    );
    this.admissions.set(key, result);
    void result
      .finally(() => {
        if (this.admissions.get(key) === result) this.admissions.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  private async admitOnce(
    key: string,
    input: AdmitMessageInput,
  ): Promise<AgentMessageAdmissionResult> {
    const file = path.join(this.directory, `${key}.json`);
    const fingerprint = digest(input.request);
    let existing: z.infer<typeof AdmissionReceiptSchema> | null;
    try {
      existing = AdmissionReceiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      existing = null;
    }
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        return { status: "rejected", reason: "message_id_conflict" };
      return existing.state === "resolved" ? existing.result : { status: "outcome_unknown" };
    }
    const receipt = { fingerprint, agentId: input.agentId };
    // Persist uncertainty before touching the provider. Rejection is a terminal
    // result too: a later attempt needs a new id and fresh preconditions.
    await writeJsonFileAtomic(file, { ...receipt, state: "pending" });
    try {
      const result = await input.admit();
      await writeJsonFileAtomic(file, { ...receipt, state: "resolved", result });
      return result;
    } catch {
      // Neither provider failure nor failure to persist acceptance authorizes replay.
      return { status: "outcome_unknown" };
    }
  }

  send(input: SendMessageInput): Promise<void> {
    // Preserve the existing on-disk identity and shape across daemon upgrades.
    const key = digest(["send", input.agentId, input.messageId]);
    const previous = this.pending.get(key);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.sendOnce(key, input),
    );
    this.pending.set(key, result);
    void result
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  private async sendOnce(key: string, input: SendMessageInput): Promise<void> {
    const file = path.join(this.directory, `${key}.json`);
    const fingerprint = digest(input.request);
    const existing = await readReceipt(file);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("agent_request_key_conflict");
      if (existing.state === "completed") return;
      // A provider may have accepted the message before its receipt was committed.
      throw new Error("agent_request_outcome_unknown");
    }
    await input.prepare?.();
    const receipt = { fingerprint, agentId: input.agentId };
    await writeJsonFileAtomic(file, { ...receipt, state: "pending" });
    await input.send();
    await writeJsonFileAtomic(file, { ...receipt, state: "completed" });
  }
}

async function readReceipt(file: string): Promise<z.infer<typeof ReceiptSchema> | null> {
  try {
    return ReceiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, candidate: unknown) => {
        if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
          return Object.fromEntries(
            Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)),
          );
        }
        return candidate;
      }),
    )
    .digest("hex");
}
