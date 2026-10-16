import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createStream, type FileSize } from "rotating-file-stream";
import {
  ConversationStore,
  SlackPolicyError,
  SlackStateError,
  parseJournal,
  writeJournal,
} from "./conversations.js";

export async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new SlackStateError("Use a real private directory");
  if (process.platform !== "win32") {
    if (info.uid !== process.getuid?.()) throw new SlackPolicyError("operations_owner");
    await chmod(directory, 0o700);
  }
}

async function privateFile(file: string): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw new SlackStateError("Use a regular snapshot file");
  if (
    process.platform !== "win32" &&
    (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
  )
    throw new SlackPolicyError("snapshot_permissions");
  return readFile(file, "utf8");
}

export async function createBridgeLog(
  directory: string,
  failed: () => void,
  limits: { size?: FileSize; maxFiles?: number } = {},
) {
  await privateDirectory(directory);
  const stream = createStream("bridge.jsonl", {
    path: directory,
    size: limits.size ?? "5M",
    interval: "1d",
    maxFiles: limits.maxFiles ?? 7,
    maxSize: "35M",
    mode: 0o600,
  });
  stream.on("error", failed);
  return {
    log(code: string, correlation?: string) {
      // Accept fixed codes and opaque hashes only. No SDK error objects, prompts or token values.
      if (
        !/^[a-z0-9_]+$/u.test(code) ||
        (correlation !== undefined && !/^[a-z0-9-]{1,128}$/u.test(correlation))
      ) {
        failed();
        return;
      }
      stream.write(
        JSON.stringify({
          at: new Date().toISOString(),
          code,
          ...(correlation ? { correlation } : {}),
        }) + "\n",
      );
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (stream.destroyed) {
          resolve();
          return;
        }
        stream.once("error", reject);
        stream.end(() => resolve());
      }),
  };
}

const BackupSchema = z.object({
  version: z.literal(1),
  createdAt: z.number(),
  release: z.string().regex(/^[a-f0-9]{40}$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  journal: z.string(),
});
const BackupName = /^\d+-[a-f0-9-]{36}\.json$/u;
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Atomic snapshots are consistent with the last committed journal, including pending work. */
export async function backupJournal(
  store: ConversationStore,
  directory: string,
  release: string,
): Promise<string> {
  await privateDirectory(directory);
  const journal = await store.snapshot();
  const createdAt = Date.now();
  const payload = BackupSchema.parse({
    version: 1,
    createdAt,
    release,
    sha256: digest(journal),
    journal,
  });
  const file = join(directory, `${createdAt}-${randomUUID()}.json`);
  const temporary = `${file}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(payload));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
  if (process.platform !== "win32") {
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
  const files = (await readdir(directory)).filter((name) => BackupName.test(name)).sort();
  const excess = new Set(files.slice(0, Math.max(0, files.length - 24)));
  for (const name of files)
    if (excess.has(name) || Number(name.split("-")[0]) < createdAt - 24 * 60 * 60_000)
      await rm(join(directory, name));
  return file;
}

export async function verifyBackup(file: string) {
  const backup = BackupSchema.parse(JSON.parse(await privateFile(file)));
  if (digest(backup.journal) !== backup.sha256)
    throw new SlackStateError("Snapshot checksum mismatch");
  return { ...backup, state: parseJournal(JSON.parse(backup.journal)) };
}

/** Caller owns PID admission. Refuse to overwrite newer work; restored ambiguity is held for review. */
export async function restoreJournal(directory: string, file: string): Promise<void> {
  await privateDirectory(directory);
  const backup = await verifyBackup(file);
  try {
    await lstat(join(directory, "conversations.json"));
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    for (const event of backup.state.intake)
      if (event.phase !== "completed") event.phase = "needs_attention";
    for (const delivery of backup.state.outbox)
      if (delivery.phase !== "sent") {
        delivery.phase = "uncertain";
        delivery.nextAttemptAt = 0;
      }
    for (const control of backup.state.controls) {
      control.expiresAt = 0;
      if (control.phase === "pending") control.phase = "claimed";
    }
    for (const receipt of backup.state.interactions)
      if (receipt.phase !== "resolved") receipt.phase = "claimed";
    await writeJournal(directory, backup.state);
    return;
  }
  throw new SlackStateError(
    "Refusing to overwrite an existing journal; recover into a fresh directory",
  );
}
