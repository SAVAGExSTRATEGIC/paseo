import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ConversationStore } from "./conversations.js";
import { backupJournal, createBridgeLog, restoreJournal, verifyBackup } from "./operations.js";
import { maintainBridge } from "./maintenance.js";
import { acquirePidLock, releasePidLock } from "../pid-lock.js";

const policy = {
  teamId: "T1",
  userIds: ["U1"],
  channelIds: ["C1"],
  allowDMs: true,
  targets: [
    { host: "local", project: "fixture", projectId: "p1", cwd: "/fixture", serverId: "srv1" },
  ],
};
const release = "a".repeat(40);
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "slack-operations-"));
  directories.push(directory);
  const store = await ConversationStore.open(directory, policy);
  const message = {
    id: "Ev1",
    teamId: "T1",
    userId: "U1",
    channelId: "C1",
    rootTs: "1.1",
    messageTs: `${Date.now() / 1000}`,
    text: "private fixture content",
    isDM: false,
  };
  await store.accept(message);
  const key = store.pending()[0].conversationKey;
  await store.bind({
    key,
    ownerId: "U1",
    target: policy.targets[0],
    agentId: "a1",
    workspaceId: "w1",
  });
  return { directory, store, message, key };
}
it("restores pending work as held with unchanged identities and uncertain deliveries, then resumes from full canonical history", async () => {
  const { directory, store, key } = await fixture();
  await store.prepareDispatch("Ev1", { epoch: "native", seq: 12 });
  await store.enqueue(key, { id: "d1", text: "pending reply" });
  const request = { id: "r1", kind: "tool", name: "shell", input: { command: "echo harmless" } };
  const token = await store.offerPermission({ key, request, now: Date.now() });
  await store.acceptInteraction({ id: "click1", token, key, actorId: "U1", behavior: "allow" });
  const file = await backupJournal(store, join(directory, "backups"), release);

  expect((await verifyBackup(file)).state.bindings[0].agentId).toBe("a1");
  const restoredDirectory = join(directory, "restored");
  await restoreJournal(restoredDirectory, file);
  const restored = await ConversationStore.open(restoredDirectory, policy);
  expect(restored.pending()[0]).toMatchObject({
    id: "Ev1",
    phase: "needs_attention",
    startCursor: { epoch: "native", seq: 12 },
  });
  expect(restored.deliveries()[0]).toMatchObject({ id: "d1", phase: "uncertain" });
  expect(restored.pendingInteractions()[0]).toMatchObject({ id: "click1", phase: "claimed" });
  await expect(
    restored.claimPermission({
      token,
      key,
      actorId: "U1",
      behavior: "allow",
      current: request,
      now: Date.now(),
    }),
  ).rejects.toThrow("expired");
  await restored.resume("Ev1");
  await restored.prepareDispatch("Ev1", { epoch: "native", seq: 100 });
  expect(restored.pending()[0]).toMatchObject({
    id: "Ev1",
    phase: "dispatching",
    startCursor: { epoch: "native", seq: 0 },
  });
  await expect(restoreJournal(restoredDirectory, file)).rejects.toThrow("overwrite");
});
it("rejects damaged snapshots without replacing live state", async () => {
  const { directory, store } = await fixture();
  const file = await backupJournal(store, join(directory, "backups"), release);
  const backup = JSON.parse(await readFile(file, "utf8"));
  backup.journal += " ";
  await writeFile(file, JSON.stringify(backup), { mode: 0o600 });
  await expect(verifyBackup(file)).rejects.toThrow("checksum");

  expect(store.pending()[0].text).toBe("private fixture content");
});
it("removes expired content while retaining bindings, unfinished work, and duplicate protection", async () => {
  const { directory, store, message, key } = await fixture();
  await store.finish("Ev1", [{ id: "d1", text: "private result" }]);
  await store.deliveryState("d1", "sent", "3.1");
  await store.accept({ ...message, id: "Ev2", messageTs: `${Number(message.messageTs) + 1}` });
  await store.finish("Ev2", []);
  await store.accept({
    ...message,
    id: "Ev3",
    messageTs: `${Number(message.messageTs) + 2}`,
    text: "unfinished content must remain",
  });
  const future = Date.now() + 91 * 24 * 60 * 60_000;
  await store.prune(future);
  const restored = await ConversationStore.open(directory, policy);
  expect(restored.binding(key)?.agentId).toBe("a1");
  expect(restored.pending().map((entry) => entry.text)).toEqual(["unfinished content must remain"]);
  expect(await readFile(join(directory, "conversations.json"), "utf8")).not.toContain(
    "private fixture content",
  );
  expect(await readFile(join(directory, "conversations.json"), "utf8")).not.toContain(
    "private result",
  );
  expect(await restored.accept(message)).toBe("duplicate");
  await expect(
    restored.accept({ ...message, id: "Ev2", messageTs: `${Number(message.messageTs) + 1}` }),
  ).rejects.toThrow("expired_message");
  await restored.accept({ ...message, id: "Ev-new", messageTs: `${future / 1000}` });
  expect(restored.binding(key)?.agentId).toBe("a1");
});
it("refuses deletion of accepted work and keeps a forgotten thread from replaying after explicit deletion", async () => {
  const { directory, store, key, message } = await fixture();
  await expect(store.forget(key)).rejects.toThrow("Resolve accepted work");
  await store.finish("Ev1", []);
  await store.forget(key);
  const restored = await ConversationStore.open(directory, policy);
  expect(restored.bindings()).toEqual([]);
  await expect(restored.accept(message)).rejects.toThrow("forgotten_conversation");
  expect(
    await restored.accept({ ...message, id: "new-thread", rootTs: "9.1", messageTs: "9.1" }),
  ).toBe("accepted");
});
it.skipIf(process.platform === "win32")(
  "rotates actual private log files, bounds retained files, and rejects content-shaped logging",
  async () => {
    const { directory } = await fixture();
    let failures = 0;
    const logger = await createBridgeLog(
      join(directory, "logs"),
      () => {
        failures++;
      },
      { size: "300B", maxFiles: 2 },
    );
    for (let index = 0; index < 50; index++)
      logger.log("fixture_event", `slack-${String(index).padStart(64, "a")}`);
    logger.log("secret content is not a code", "xoxb-private-value");
    await logger.close();
    const files = (await readdir(join(directory, "logs"))).filter((name) =>
      name.endsWith(".jsonl"),
    );
    expect(files.length).toBeGreaterThan(1);
    expect(files.length).toBeLessThanOrEqual(3);
    const content = (
      await Promise.all(files.map((name) => readFile(join(directory, "logs", name), "utf8")))
    ).join("");
    expect(content).toContain("fixture_event");
    expect(content).not.toContain("xoxb-private-value");
    expect(failures).toBe(1);
    for (const name of files)
      expect((await stat(join(directory, "logs", name))).mode & 0o777).toBe(0o600);
  },
);
it("requires recorded cancellation, a matching agent and stopped-process acknowledgement before closing held work", async () => {
  const { directory, store } = await fixture();
  const config = join(directory, "bridge-settings.json");
  await writeFile(
    config,
    JSON.stringify({
      appId: "A1",
      botUserId: "U9",
      dataDirectory: directory,
      healthPort: 34672,
      policy,
      hosts: [
        {
          name: "local",
          url: "ws://127.0.0.1:6767/ws",
          serverId: "srv1",
          passwordEnv: "FIXTURE_PASSWORD",
          agentConfig: { provider: "codex/fixture" },
        },
      ],
    }),
  );
  await store.prepareDispatch("Ev1", { epoch: "native", seq: 1 });
  await store.transition("Ev1", "dispatching", "needs_attention");
  await expect(
    maintainBridge(config, "resolve-canceled", ["Ev1", "a1", "processes-stopped"]),
  ).rejects.toThrow("recorded native cancellation");
  await store.resume("Ev1");
  await store.prepareDispatch("Ev1", { epoch: "native", seq: 1 });
  await store.recordTerminal(store.pending()[0].conversationKey, "canceled");
  await store.transition("Ev1", "dispatching", "needs_attention");
  await expect(maintainBridge(config, "resolve-canceled", ["Ev1", "a1"])).rejects.toThrow(
    "processes-stopped",
  );
  await expect(
    maintainBridge(config, "resolve-canceled", ["Ev1", "other", "processes-stopped"]),
  ).rejects.toThrow("match the held task");
  await expect(
    maintainBridge(config, "resolve-canceled", ["Ev1", "a1", "processes-stopped"]),
  ).resolves.toMatchObject({ resolved: "Ev1", terminal: "canceled", replayed: false });
  const resolved = await ConversationStore.open(directory, policy);
  expect(resolved.pending()).toEqual([]);
  expect(resolved.deliveries()).toHaveLength(1);
  expect(resolved.deliveries()[0].text).toContain("Canceled (operator verified)");
  await expect(
    maintainBridge(config, "resolve-canceled", ["Ev1", "a1", "processes-stopped"]),
  ).rejects.toThrow("Only held tasks");
});

it("refuses maintenance while the service owns PID admission", async () => {
  const { directory } = await fixture();
  const config = join(directory, "bridge-settings.json");
  await writeFile(
    config,
    JSON.stringify({
      appId: "A1",
      botUserId: "U9",
      dataDirectory: directory,
      healthPort: 34672,
      policy,
      hosts: [
        {
          name: "local",
          url: "ws://127.0.0.1:6767/ws",
          serverId: "srv1",
          passwordEnv: "FIXTURE_PASSWORD",
          agentConfig: { provider: "codex/fixture" },
        },
      ],
    }),
  );
  await acquirePidLock(directory, null);
  try {
    await expect(maintainBridge(config, "prune", [])).rejects.toThrow("Stop the bridge");
    await expect(
      maintainBridge(config, "resolve-canceled", ["Ev1", "a1", "processes-stopped"]),
    ).rejects.toThrow("Stop the bridge");
  } finally {
    await releasePidLock(directory);
  }
});

it.skipIf(process.platform === "win32")("requires private Unix snapshot permissions", async () => {
  const { directory, store } = await fixture();
  const file = await backupJournal(store, join(directory, "backups"), release);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  await chmod(file, 0o644);
  await expect(verifyBackup(file)).rejects.toThrow("snapshot_permissions");
});
