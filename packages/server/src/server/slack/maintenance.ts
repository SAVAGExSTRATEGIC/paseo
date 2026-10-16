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
import { stableOperationId } from "./daemon.js";
import { backupJournal, restoreJournal, verifyBackup } from "./operations.js";

async function resolveCanceled(store: ConversationStore, args: string[]): Promise<object> {
  if (args.length !== 3 || args[2] !== "processes-stopped")
    throw new SlackStateError(
      "Use: resolve-canceled <intake-id> <agent-id> processes-stopped after verifying native cancellation and stopped processes",
    );
  const event = store.pending().find((entry) => entry.id === args[0]);
  if (
    !event ||
    event.phase !== "needs_attention" ||
    event.terminal !== "canceled" ||
    parseSlackCommand(event.text).kind !== "prompt"
  )
    throw new SlackStateError("Only held tasks with recorded native cancellation can be resolved");
  const binding = store.binding(event.conversationKey);
  if (!binding || binding.agentId !== args[1])
    throw new SlackStateError("The inspected agent must match the held task binding");
  store.destination(event.conversationKey);
  await store.finish(event.id, [
    {
      id: stableOperationId("final-0", event.id),
      text: "Canceled (operator verified): the task's native execution was stopped in Paseo. Its accepted input was closed without replaying it.",
    },
  ]);
  return {
    resolved: event.id,
    agentId: binding.agentId,
    terminal: "canceled",
    replayed: false,
  };
}

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
  if (!new Set(["backup", "restore", "prune", "resume", "resolve-canceled", "forget"]).has(action))
    throw new SlackStateError(
      "Actions: backup, verify, restore, prune, resume, resolve-canceled, forget",
    );
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
    if (action === "resolve-canceled") return await resolveCanceled(store, args);
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
