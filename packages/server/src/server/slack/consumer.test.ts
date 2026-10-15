import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ConversationStore } from "./conversations.js";
import { createSocketConsumer } from "./consumer.js";
import type { BridgeConfig } from "./config.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "slack-consumer-"));
  directories.push(directory);
  const target = {
    host: "local",
    project: "fixture",
    projectId: "p1",
    cwd: "/fixture",
    serverId: "srv1",
  };
  const config: BridgeConfig = {
    appId: "A1",
    botUserId: "U9",
    dataDirectory: directory,
    healthPort: 34672,
    policy: {
      teamId: "T1",
      userIds: ["U1"],
      channelIds: ["C1"],
      allowDMs: true,
      targets: [target],
    },
    hosts: [
      {
        name: "local",
        url: "ws://127.0.0.1:6767/ws",
        serverId: "srv1",
        passwordEnv: "FIXTURE_PASSWORD",
        agentConfig: { provider: "codex/fixture" },
      },
    ],
  };
  const store = await ConversationStore.open(directory, config.policy);
  const failures: string[] = [];
  const consumer = createSocketConsumer({
    config,
    store,
    state: () => {},
    failure: (code) => {
      failures.push(code);
    },
  });
  return { directory, config, store, consumer, failures, target };
}
const payload = {
  type: "event_callback",
  api_app_id: "A1",
  team_id: "T1",
  event_id: "Ev1",
  event: { type: "app_mention", user: "U1", channel: "C1", text: "<@U9> hello", ts: "1.1" },
};
it("commits before returning acknowledgement eligibility and deduplicates mention/message deliveries after restart", async () => {
  const { directory, config, store, consumer } = await fixture();
  await consumer.accept("events_api", payload, "envelope1");
  expect((await ConversationStore.open(directory, config.policy)).pending()).toHaveLength(1);
  await consumer.accept(
    "events_api",
    { ...payload, event_id: "Ev-copy", event: { ...payload.event, type: "message" } },
    "envelope2",
  );
  await consumer.accept(
    "events_api",
    {
      ...payload,
      event_id: "Ev-next",
      event: { ...payload.event, type: "message", text: "follow-up", ts: "2.1", thread_ts: "1.1" },
    },
    "envelope3",
  );
  expect(store.pending().map((entry) => entry.text)).toEqual(["hello", "follow-up"]);
});
it("acknowledges policy rejection without saving foreign content, and journals authorized interactions before returning", async () => {
  const { directory, config, store, consumer, failures, target } = await fixture();
  await consumer.accept("events_api", { ...payload, team_id: "T2" }, "foreign");
  expect(store.pending()).toEqual([]);
  expect(failures).toEqual(["slack_input_policy_rejected"]);
  await consumer.accept("events_api", payload, "good");
  const key = store.pending()[0].conversationKey;
  await store.bind({ key, ownerId: "U1", target, agentId: "a1", workspaceId: "w1" });
  const token = await store.offerPermission({
    key,
    request: { id: "r1", kind: "tool", name: "shell", input: { command: "echo hello" } },
    now: Date.now(),
  });
  const interaction = {
    type: "block_actions",
    api_app_id: "A1",
    team: { id: "T1" },
    user: { id: "U1" },
    channel: { id: "C1" },
    message: { ts: "3.1", thread_ts: "1.1" },
    actions: [{ action_id: "paseo_allow", value: token }],
  };
  await consumer.accept("interactive", { ...interaction, user: { id: "U2" } }, "bad-actor");
  expect(store.pendingInteractions()).toEqual([]);
  await consumer.accept("interactive", interaction, "click1");
  await consumer.accept("interactive", interaction, "click1");
  expect((await ConversationStore.open(directory, config.policy)).pendingInteractions()).toEqual([
    { id: "click1", token, key, actorId: "U1", behavior: "allow", phase: "accepted" },
  ]);
});
