import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { acquirePidLock, isLocked, releasePidLock } from "../pid-lock.js";
import { readBridgeConfig, requireSecret } from "./config.js";
import {
  ConversationStore,
  SlackPolicyError,
  SlackStateError,
  conversationKey,
} from "./conversations.js";
import { parseSlackCommand } from "./commands.js";
import { backupJournal, restoreJournal, verifyBackup } from "./operations.js";

export async function maintainBridge(
  file: string,
  action: string,
  args: string[],
): Promise<object> {
  const config = await readBridgeConfig(file);
  if (action === "verify") {
    if (args.length !== 1) throw new SlackStateError("Use: verify <snapshot-file>");
    const backup = await verifyBackup(args[0]);
    return {
      verified: true,
      createdAt: backup.createdAt,
      release: backup.release,
      sha256: backup.sha256,
      bindings: backup.state.bindings.length,
      unfinished: backup.state.intake.filter((entry) => entry.phase !== "completed").length,
    };
  }
  if (!new Set(["backup", "restore", "prune", "resume", "forget"]).has(action))
    throw new SlackStateError("Actions: backup, verify, restore, prune, resume, forget");
  if ((await isLocked(config.dataDirectory)).locked)
    throw new SlackStateError("Stop the bridge before maintenance");
  await acquirePidLock(config.dataDirectory, null);
  try {
    if (action === "restore") {
      if (args.length !== 1)
        throw new SlackStateError("Use: restore <snapshot-file> into a fresh data directory");
      await restoreJournal(config.dataDirectory, args[0]);
      return { restored: true, unfinishedWorkHeld: true, outboundReconciliationRequired: true };
    }
    const store = await ConversationStore.open(config.dataDirectory, config.policy);
    if (action === "resume") {
      if (args.length !== 1)
        throw new SlackStateError("Use: resume <intake-id> after inspecting the native session");
      const event = store.pending().find((entry) => entry.id === args[0]);
      if (!event || parseSlackCommand(event.text).kind !== "prompt")
        throw new SlackStateError(
          "Only an inspected held task can resume; controls and commands are never replayed",
        );
      await store.resume(event.id);
      return { resumed: event.id, originalMessageIdentityPreserved: true };
    }
    if (action === "forget") {
      if (args.length !== 2)
        throw new SlackStateError("Use: forget <channel-id> <root-thread-timestamp>");
      await store.forget(
        conversationKey({ teamId: config.policy.teamId, channelId: args[0], rootTs: args[1] }),
      );
      return { forgotten: true, useNewThread: true, backupRetentionUnchanged: true };
    }
    if (args.length !== 0) throw new SlackStateError("Unexpected maintenance arguments");
    if (action === "prune") await store.prune(Date.now());
    const snapshot = await backupJournal(
      store,
      join(config.dataDirectory, "backups"),
      requireSecret(process.env, "PASEO_SLACK_RELEASE"),
    );
    return { snapshot, pruned: action === "prune" };
  } finally {
    await releasePidLock(config.dataDirectory);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file, action, ...args] = process.argv.slice(2);
  if (!file || !action) {
    process.stderr.write("Use: maintenance.js <config-file> <action> [arguments]\n");
    process.exitCode = 1;
  } else
    maintainBridge(file, action, args)
      .then((result) => {
        process.stdout.write(JSON.stringify(result) + "\n");
        return undefined;
      })
      .catch((error: unknown) => {
        let reason = "maintenance_failed";
        if (error instanceof SlackPolicyError) reason = error.code;
        else if (error instanceof SlackStateError) reason = error.message;
        process.stderr.write(JSON.stringify({ error: reason }) + "\n");
        process.exitCode = 1;
      });
}
