import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore } from "./conversations.js";
const policy = {
  teamId: "T1",
  userIds: ["U1"],
  channelIds: ["C1"],
  allowDMs: true,
  targets: [
    { host: "local", project: "fixture", projectId: "p1", cwd: "/fixture", serverId: "srv1" },
  ],
};
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "paseo-permission-"));
  directories.push(directory);
  const store = await ConversationStore.open(directory, policy);
  await store.accept({
    id: "Ev1",
    teamId: "T1",
    userId: "U1",
    channelId: "C1",
    rootTs: "1.1",
    messageTs: "1.1",
    text: "hello",
    isDM: false,
  });
  const key = store.pending()[0].conversationKey;
  await store.bind({
    key,
    ownerId: "U1",
    target: policy.targets[0],
    agentId: "a1",
    workspaceId: "w1",
  });
  return { directory, store, key, controls: store };
}
const request = {
  id: "r1",
  provider: "claude",
  name: "Bash",
  kind: "tool",
  input: { command: "printf hello" },
};
describe("Slack permission controls", () => {
  it("binds an approval to its actor, conversation, live request and expiry", async () => {
    const { controls, key } = await fixture();
    const token = await controls.offerPermission({ key, request, now: 100 });
    for (const overrides of [
      { actorId: "U2" },
      { key: "other" },
      { now: 700_101 },
      { current: { ...request, id: "r2" } },
      { current: { ...request, input: { command: "rm file" } } },
    ]) {
      await expect(
        controls.claimPermission({
          token,
          key,
          actorId: "U1",
          behavior: "allow",
          current: request,
          now: 101,
          ...overrides,
        }),
      ).rejects.toThrow();
    }
    expect(
      await controls.claimPermission({
        token,
        key,
        actorId: "U1",
        behavior: "allow",
        current: request,
        now: 101,
      }),
    ).toMatchObject({ requestId: "r1", agentId: "a1", behavior: "allow" });
  });
  it("persists a denial claim before execution and refuses replay after restart", async () => {
    const { controls, directory, key } = await fixture();
    const token = await controls.offerPermission({ key, request, now: 100 });
    await controls.claimPermission({
      token,
      key,
      actorId: "U1",
      behavior: "deny",
      current: request,
      now: 101,
    });
    const reopened = await ConversationStore.open(directory, policy);
    await expect(
      reopened.claimPermission({
        token,
        key,
        actorId: "U1",
        behavior: "allow",
        current: request,
        now: 102,
      }),
    ).rejects.toThrow("already claimed");
  });
  it("offers questions through a distinct input path and never as blanket approval", async () => {
    const { controls, key } = await fixture();
    await expect(
      controls.offerPermission({ key, request: { ...request, kind: "question" }, now: 100 }),
    ).rejects.toThrow("user-input");
  });
  it("keeps question tokens separate from tool approvals and persists answer claims", async () => {
    const { store, directory, key } = await fixture();
    const question = {
      ...request,
      kind: "question",
      name: "request_user_input",
      input: { questions: [{ header: "Color", question: "Which?" }] },
    };
    const toolToken = await store.offerPermission({ key, request, now: 100 });
    const questionToken = await store.offerQuestion({ key, request: question, now: 100 });
    const claim = { key, actorId: "U1", current: question, now: 101 };
    await expect(store.claimQuestion({ ...claim, token: toolToken })).rejects.toThrow();
    await expect(
      store.claimPermission({ ...claim, token: questionToken, behavior: "allow" }),
    ).rejects.toThrow();
    await expect(
      store.claimQuestion({ ...claim, token: questionToken, actorId: "U2" }),
    ).rejects.toThrow();
    await store.prepareDispatch("Ev1", { epoch: "fixture", seq: 0 });
    await store.recordTerminal(key, "completed");
    expect(
      await store.claimQuestion(
        { ...claim, token: questionToken },
        "Answers to your questions: fixture",
      ),
    ).toMatchObject({
      requestId: question.id,
    });
    const reopened = await ConversationStore.open(directory, policy);
    await expect(reopened.claimQuestion({ ...claim, token: questionToken })).rejects.toThrow(
      "already claimed",
    );
  });
});
