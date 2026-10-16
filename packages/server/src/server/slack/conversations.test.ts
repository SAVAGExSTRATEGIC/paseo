import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore, SlackPolicyError } from "./conversations.js";

const policy = {
  teamId: "T1",
  userIds: ["U1"],
  channelIds: ["C1", "C2"],
  allowDMs: true,
  targets: [
    { host: "local", project: "fixture", projectId: "p1", cwd: "/fixture", serverId: "srv1" },
  ],
};
const directories: string[] = [];
async function openStore() {
  const dir = await mkdtemp(join(tmpdir(), "paseo-slack-"));
  directories.push(dir);
  return { dir, store: await ConversationStore.open(dir, policy) };
}
function message(overrides = {}) {
  return {
    id: "Ev1",
    teamId: "T1",
    userId: "U1",
    channelId: "C1",
    rootTs: "1.1",
    messageTs: "1.1",
    text: "hello",
    isDM: false,
    ...overrides,
  };
}
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("Slack durable conversations", () => {
  it.skipIf(process.platform === "win32")(
    "writes the journal with private Unix permissions",
    async () => {
      const { store, dir } = await openStore();
      await store.accept(message());
      expect((await stat(join(dir, "conversations.json"))).mode & 0o777).toBe(0o600);
    },
  );
  it("durably deduplicates delivery and separates thread identities", async () => {
    const { store, dir } = await openStore();
    expect(await store.accept(message())).toBe("accepted");
    expect(await store.accept(message())).toBe("duplicate");
    await store.accept(message({ id: "Ev2", rootTs: "2.1", messageTs: "2.1" }));
    const reopened = await ConversationStore.open(dir, policy);
    expect(reopened.pending()).toHaveLength(2);
    expect(new Set(reopened.pending().map((event) => event.conversationKey)).size).toBe(2);
  });

  it("rejects all unallowed boundaries before recording content", async () => {
    const { store, dir } = await openStore();
    for (const overrides of [
      { userId: "U2" },
      { teamId: "T2" },
      { channelId: "C3" },
      { isDM: true, channelId: "C1" },
    ]) {
      await expect(
        store.accept(message({ text: "DO_NOT_PERSIST", ...overrides })),
      ).rejects.toBeInstanceOf(SlackPolicyError);
    }
    expect(await readFile(join(dir, "conversations.json"), "utf8")).not.toContain("DO_NOT_PERSIST");
  });

  it("serializes concurrent intake and does not lose either accepted prompt", async () => {
    const { store, dir } = await openStore();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.accept(message({ id: `Ev${i}`, messageTs: `${i + 1}.1` })),
      ),
    );
    expect((await ConversationStore.open(dir, policy)).pending()).toHaveLength(12);
  });

  it("binds one session to one Slack conversation and refuses target changes", async () => {
    const { store } = await openStore();
    await store.accept(message());
    await store.accept(message({ id: "Ev2", rootTs: "2.1", messageTs: "2.1" }));
    const [first, second] = store.pending();
    await store.bind({
      key: first.conversationKey,
      ownerId: "U1",
      target: policy.targets[0],
      agentId: "a1",
      workspaceId: "w1",
    });
    await expect(
      store.bind({
        key: second.conversationKey,
        ownerId: "U1",
        target: policy.targets[0],
        agentId: "a1",
        workspaceId: "w1",
      }),
    ).rejects.toThrow("already attached");
    await expect(
      store.bind({
        key: first.conversationKey,
        ownerId: "U1",
        target: policy.targets[0],
        agentId: "a2",
        workspaceId: "w2",
      }),
    ).rejects.toThrow("already bound");
  });

  it("retains uncertain dispatch state through restart and rejects blind redispatch", async () => {
    const { store, dir } = await openStore();
    await store.accept(message());
    await store.transition("Ev1", "accepted", "dispatching");
    const reopened = await ConversationStore.open(dir, policy);
    expect(reopened.pending()[0].phase).toBe("dispatching");
    await expect(reopened.transition("Ev1", "accepted", "dispatching")).rejects.toThrow(
      "state conflict",
    );
  });

  it("atomically checkpoints timeline and deduplicates its outbox after restart", async () => {
    const { store, dir } = await openStore();
    await store.accept(message());
    const key = store.pending()[0].conversationKey;
    await store.bind({
      key,
      ownerId: "U1",
      target: policy.targets[0],
      agentId: "a1",
      workspaceId: "w1",
    });
    await store.checkpoint({
      key,
      cursor: { epoch: "e1", seq: 5 },
      outputs: [{ id: "final-1", text: "complete" }],
    });
    const reopened = await ConversationStore.open(dir, policy);
    await reopened.checkpoint({
      key,
      cursor: { epoch: "e1", seq: 5 },
      outputs: [{ id: "final-1", text: "complete" }],
    });
    expect(reopened.deliveries()).toHaveLength(1);
    expect(reopened.binding(key)?.cursor).toEqual({ epoch: "e1", seq: 5 });
  });
});
