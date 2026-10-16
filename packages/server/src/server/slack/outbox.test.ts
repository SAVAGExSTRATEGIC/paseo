import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStore } from "./conversations.js";
import { SlackApi } from "./slack-api.js";
import { SlackOutbox } from "./outbox.js";

const policy = {
  teamId: "T1",
  userIds: ["U1"],
  channelIds: ["C1"],
  allowDMs: true,
  targets: [
    { host: "local", project: "fixture", projectId: "p1", cwd: "/fixture", serverId: "srv1" },
  ],
};
const credentials = {
  botToken: "secret-bot",
  appToken: "secret-app",
  teamId: "T1",
  botUserId: "B1",
};
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "paseo-outbox-"));
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
  await store.enqueue(key, { id: "d1", text: "first" });
  return { directory, store, key };
}
function confirmed() {
  return Response.json({
    ok: true,
    messages: [
      {
        ts: "2.1",
        user: "B1",
        metadata: { event_type: "paseo_delivery", event_payload: { id: "d1" } },
      },
    ],
    has_more: false,
  });
}
describe("Slack durable delivery recovery", () => {
  it("recovers a crash after sending without posting the same reply again", async () => {
    const { store, directory } = await fixture();
    await store.beginDelivery("d1");
    const recovered = await ConversationStore.open(directory, policy);
    const methods: string[] = [];
    const api = new SlackApi(credentials, async (url) => {
      methods.push(String(url));
      return confirmed();
    });
    await new SlackOutbox({ store: recovered, api, now: () => 1000, failure: () => {} }).flush();
    expect(recovered.deliveries()).toEqual([]);
    expect(methods).toEqual(["https://slack.com/api/conversations.replies"]);
  });
  it("reconciles a lost acknowledgement after restart with exactly one write attempt", async () => {
    const { store, directory } = await fixture();
    let clock = 1000;
    let posts = 0;
    const api = new SlackApi(credentials, async (url) => {
      if (String(url).endsWith("chat.postMessage")) {
        posts++;
        throw new Error("lost acknowledgement secret-bot");
      }
      return confirmed();
    });
    const failureCodes: string[] = [];
    const input = {
      api,
      now: () => clock,
      failure: (code: string) => {
        failureCodes.push(code);
      },
    };
    await new SlackOutbox({ ...input, store }).flush();
    expect(store.deliveries()[0].phase).toBe("uncertain");
    clock += 30_000;
    const recovered = await ConversationStore.open(directory, policy);
    await new SlackOutbox({ ...input, store: recovered }).flush();
    expect(posts).toBe(1);
    expect(recovered.deliveries()).toHaveLength(0);
    expect(failureCodes.join()).not.toContain("secret-bot");
  });
  it("honors Retry-After and serializes simultaneous flushes", async () => {
    const { store } = await fixture();
    let clock = 1000;
    let posts = 0;
    const api = new SlackApi(credentials, async () => {
      posts++;
      return posts === 1
        ? new Response("", { status: 429, headers: { "retry-after": "12" } })
        : Response.json({ ok: true, ts: "2.1", channel: "C1" });
    });
    const outbox = new SlackOutbox({ store, api, now: () => clock, failure: () => {} });
    await Promise.all([outbox.flush(), outbox.flush()]);
    clock = 12_999;
    await outbox.flush();
    expect(posts).toBe(1);
    clock = 13_000;
    await outbox.flush();
    expect(posts).toBe(2);
    expect(store.deliveries()).toHaveLength(0);
  });
  it("holds an ambiguous missing reply and blocks later replies in that conversation", async () => {
    const { store, key } = await fixture();
    await store.beginDelivery("d1");
    await store.enqueue(key, { id: "d2", text: "second" });
    const methods: string[] = [];
    const api = new SlackApi(credentials, async (url) => {
      methods.push(String(url));
      return Response.json({ ok: true, messages: [], has_more: false });
    });
    await new SlackOutbox({ store, api, now: () => 1000, failure: () => {} }).flush();
    expect(methods).toEqual(["https://slack.com/api/conversations.replies"]);
    expect(store.deliveries().map((entry) => entry.phase)).toEqual(["uncertain", "pending"]);
  });
  it("checks changed policy before resuming an outbound delivery", async () => {
    const { directory } = await fixture();
    const revoked = await ConversationStore.open(directory, { ...policy, userIds: ["U2"] });
    let calls = 0;
    const api = new SlackApi(credentials, async () => {
      calls++;
      return confirmed();
    });
    const failures: string[] = [];
    await new SlackOutbox({
      store: revoked,
      api,
      now: () => 1000,
      failure: (code) => {
        failures.push(code);
      },
    }).flush();
    expect(calls).toBe(0);
    expect(failures).toEqual(["outbox_policy_rejected"]);
  });
});
