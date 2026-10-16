import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { acquirePidLock, releasePidLock, startPidLockHeartbeat } from "../pid-lock.js";
import { readBridgeConfig, requireSecret, type BridgeConfig } from "./config.js";
import { ConversationStore, SlackPolicyError } from "./conversations.js";
import { createSocketConsumer } from "./consumer.js";
import { SlackDaemon, stableOperationId } from "./daemon.js";
import { serveHealth, type BridgeHealth } from "./health.js";
import { SlackOutbox } from "./outbox.js";
import { ConversationRunner } from "./runner.js";
import { SlackApi } from "./slack-api.js";
import { runSocketMode } from "./socket.js";
import { backupJournal, createBridgeLog } from "./operations.js";

function bootstrapLog(code: string, correlation?: string): void {
  process.stdout.write(
    JSON.stringify({
      at: new Date().toISOString(),
      code,
      ...(correlation ? { correlation } : {}),
    }) + "\n",
  );
}

async function checkHosts(
  config: BridgeConfig,
  hosts: ReadonlyMap<string, SlackDaemon>,
): Promise<boolean> {
  const results = await Promise.allSettled(
    config.hosts.map(async (entry) => {
      const host = hosts.get(entry.name);
      if (!host) throw new SlackPolicyError("missing_host");
      await host.connect();
      for (const target of config.policy.targets.filter(
        (candidate) => candidate.host === entry.name,
      ))
        await host.verifyTarget(target);
    }),
  );
  return results.every((result) => result.status === "fulfilled");
}

export async function runBridge(file: string, signal: AbortSignal): Promise<void> {
  const config = await readBridgeConfig(file);
  const release = requireSecret(process.env, "PASEO_SLACK_RELEASE");
  if (!/^[0-9a-f]{40}$/u.test(release)) throw new SlackPolicyError("release_commit_required");
  const api = new SlackApi({
    botToken: requireSecret(process.env, "PASEO_SLACK_BOT_TOKEN"),
    appToken: requireSecret(process.env, "PASEO_SLACK_APP_TOKEN"),
    teamId: config.policy.teamId,
    botUserId: config.botUserId,
  });
  await api.verifyIdentity();
  // Configuration validates a separate pre-provisioned private directory before PID admission.
  await acquirePidLock(config.dataDirectory, null);
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  let logger: Awaited<ReturnType<typeof createBridgeLog>> | undefined;
  const log = (code: string, correlation?: string) => {
    if (logger) logger.log(code, correlation);
    else bootstrapLog(code, correlation);
  };
  const stopHeartbeat = startPidLockHeartbeat(config.dataDirectory, {
    onError: () => {
      log("bridge_lock_lost");
      stop();
    },
  });
  const hosts = new Map<string, SlackDaemon>();
  let closeHealth: (() => Promise<void>) | undefined;
  let runner: ConversationRunner | undefined;
  let socket: Promise<void> | undefined;
  try {
    logger = await createBridgeLog(join(config.dataDirectory, "logs"), stop);
    const store = await ConversationStore.open(config.dataDirectory, config.policy);
    await store.prune(Date.now());
    await backupJournal(store, join(config.dataDirectory, "backups"), release);
    for (const entry of config.hosts)
      hosts.set(
        entry.name,
        new SlackDaemon({ ...entry, password: requireSecret(process.env, entry.passwordEnv) }),
      );
    const health: BridgeHealth = {
      release,
      socketConnected: false,
      hostsReady: false,
      lastTickAt: Date.now(),
      pendingInputs: store.pending().length,
      pendingDeliveries: store.deliveries().length,
      needsAttention: 0,
    };
    closeHealth = (
      await serveHealth(config.healthPort, () => ({
        ...health,
        hostsReady: health.hostsReady && [...hosts.values()].every((host) => host.ready),
      }))
    ).close;
    const failures = new Map<string, number>();
    const failure = (code: string, identity = "bridge") => {
      const correlation = stableOperationId("correlation", identity);
      const key = `${code}:${correlation}`;
      const last = failures.get(key) ?? 0;
      if (Date.now() - last >= 60_000) {
        log(code, correlation);
        failures.set(key, Date.now());
      }
    };
    runner = new ConversationRunner({ config, store, hosts, signal: controller.signal, failure });
    const outbox = new SlackOutbox({ store, api, failure, now: Date.now });
    const consumer = createSocketConsumer({
      config,
      store,
      failure,
      state: (connected) => {
        if (health.socketConnected !== connected)
          log(connected ? "slack_socket_connected" : "slack_socket_disconnected");
        health.socketConnected = connected;
      },
    });
    socket = runSocketMode(api, consumer, controller.signal).catch(() => {
      log("socket_loop_failed");
      stop();
    });
    let hostsCheck: Promise<void> | undefined;
    let nextCheck = 0;
    let nextMaintenance = Date.now() + 60 * 60_000;
    log("bridge_started", release);
    while (!controller.signal.aborted) {
      if (health.hostsReady && [...hosts.values()].some((host) => !host.ready)) {
        health.hostsReady = false;
        log("paseo_unavailable");
      }
      if (!hostsCheck && Date.now() >= nextCheck) {
        hostsCheck = checkHosts(config, hosts)
          .then((ready) => {
            if (health.hostsReady !== ready) log(ready ? "paseo_ready" : "paseo_unavailable");
            health.hostsReady = ready;
            return undefined;
          })
          .finally(() => {
            hostsCheck = undefined;
            nextCheck = Date.now() + 10_000;
          });
      }
      if (Date.now() >= nextMaintenance) {
        await store.prune(Date.now());
        await backupJournal(store, join(config.dataDirectory, "backups"), release);
        nextMaintenance = Date.now() + 60 * 60_000;
        log("journal_maintenance_complete");
      }
      await runner.tick();
      await outbox.flush();
      health.lastTickAt = Date.now();
      const pending = store.pending();
      health.pendingInputs = pending.length;
      health.pendingDeliveries = store.deliveries().length;
      health.needsAttention =
        pending.filter((entry) => entry.phase === "needs_attention").length +
        store.deliveries().filter((entry) => entry.phase === "uncertain").length +
        store.pendingInteractions().filter((entry) => entry.phase === "claimed").length;
      await delay(500, undefined, { signal: controller.signal }).catch(() => undefined);
    }
    await hostsCheck;
  } catch (error) {
    log("bridge_fatal");
    throw error;
  } finally {
    stop();
    await Promise.allSettled([
      socket,
      runner?.close(),
      ...[...hosts.values()].map((host) => host.close()),
    ]);
    try {
      await closeHealth?.();
    } finally {
      stopHeartbeat();
      signal.removeEventListener("abort", stop);
      await releasePidLock(config.dataDirectory);
      log("bridge_stopped");
      await logger?.close();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const file = process.argv[2];
  if (!file) {
    bootstrapLog("bridge_config_argument_required");
    process.exitCode = 1;
  } else
    runBridge(file, controller.signal).catch(() => {
      bootstrapLog("bridge_fatal");
      process.exitCode = 1;
    });
}
