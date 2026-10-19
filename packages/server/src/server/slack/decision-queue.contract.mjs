import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes, createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const uri = (s) =>
    "data:text/javascript;base64," +
    Buffer.from(stripTypeScriptTypes(s, { mode: "transform" })).toString("base64"),
  require = createRequire((process.env.DQ_TEST_PACKAGE_ROOT || process.cwd()) + "/package.json"),
  zod = JSON.stringify(pathToFileURL(require.resolve("zod")).href),
  storeURL = uri(
    (await readFile(new URL("./conversations.ts", import.meta.url), "utf8")).replace(
      'from "zod"',
      `from ${zod}`,
    ),
  ),
  code = (await readFile(new URL("./decision-queue.ts", import.meta.url), "utf8")).replace(
    'from "./conversations.js"',
    `from ${JSON.stringify(storeURL)}`,
  ),
  { createSlackDecisionQueue, parseDecisionCommand } = await import(uri(code));
const policy = {
    teamId: "T1",
    userIds: ["U1"],
    channelIds: ["C1"],
    allowDMs: false,
    targets: [],
  },
  binding = {
    teamId: "T1",
    userId: "U1",
    channelId: "C1",
    rootTs: "1.1",
    isDM: false,
    questionId: "canonical-q",
    taskId: "SAV2-1357",
    originRevision: "a".repeat(64),
    disclosureApproved: true,
  };
function fixture() {
  let q = {
      id: "canonical-q",
      taskId: "SAV2-1357",
      originRevision: "a".repeat(64),
      version: 1,
      question: "Choose <@U2> safely?",
      context: "Original context",
      options: ["First", "Custom"],
      recommended: 0,
      state: "open",
      secret: false,
    },
    writes = 0,
    reads = 0,
    lost = false,
    serial = Promise.resolve();
  const receipts = new Map(),
    events = [];
  const port = {
    async read() {
      reads++;
      return structuredClone(q);
    },
    async receipt(id) {
      return structuredClone(receipts.get(id) ?? null);
    },
    commit(e) {
      const p = serial.then(() => {
        const old = receipts.get(e.eventId);
        if (old) {
          assert.equal(old.eventDigest, e.eventDigest);
          return structuredClone(old);
        }
        assert.equal(e.expectedVersion, q.version);
        events.push(e);
        writes++;
        q.version++;
        if (e.action === "answer") {
          q.state = "answered";
          q.answer = e.text;
        } else if (e.action === "defer") q.state = "deferred";
        else if (e.action === "skip") q.state = "skipped";
        else if (e.action === "resume") q.state = "open";
        const receipt = {
          eventId: e.eventId,
          eventDigest: e.eventDigest,
          questionId: q.id,
          taskId: q.taskId,
          originRevision: q.originRevision,
          version: q.version,
        };
        receipts.set(e.eventId, receipt);
        if (lost) {
          lost = false;
          throw Error("lost acknowledgment");
        }
        return structuredClone(receipt);
      });
      serial = p.catch(() => {});
      return p;
    },
  };
  const adapter = createSlackDecisionQueue(policy, binding, port),
    event = (token, action = "answer", text = "custom answer", id = "Ev1") => ({
      ...binding,
      id,
      messageTs: "1.2",
      conversationKey: "bound-thread",
      receivedAt: 1,
      phase: "accepted",
      text: `decision ${action} ${token} ${text}`,
    });
  return {
    adapter,
    port,
    event,
    events,
    receipts,
    q,
    writes: () => writes,
    reads: () => reads,
    lose: () => (lost = true),
  };
}
test("canonical card keeps source identity, escapes mentions and never sends or marks delivered", async () => {
  const f = fixture(),
    c = await f.adapter.card(binding);
  assert.equal(c.questionId, "canonical-q");
  assert.match(c.text, /&lt;@U2&gt;/);
  assert.equal(c.delivered, false);
  assert.equal(c.reminderEligible, true);
  assert.match(c.text, /decision discuss/);
  assert.equal(f.writes(), 0);
});
test("chosen and custom exact answers use the same canonical conditional commit", async () => {
  for (const text of ["First", "Keep scope narrow.\nCustom answer with spaces  "]) {
    const f = fixture(),
      c = await f.adapter.card(binding);
    const r = await f.adapter.handle(f.event(c.token, "answer", text));
    assert.equal(r.dispatchAllowed, false);
    assert.equal(f.q.answer, text);
    assert.equal(f.events[0].source.actor, "U1");
    assert.equal(f.events[0].taskId, "SAV2-1357");
    assert.equal(f.writes(), 1);
  }
});
test("discussion never becomes approval; later answer uses fresh canonical version", async () => {
  const f = fixture(),
    c = await f.adapter.card(binding);
  await f.adapter.handle(f.event(c.token, "discuss", "Explain the alternatives"));
  assert.equal(f.q.answer, undefined);
  assert.equal(f.q.state, "open");
  const fresh = await f.adapter.card(binding);
  await f.adapter.handle(f.event(fresh.token, "answer", "First", "Ev2"));
  assert.equal(f.q.answer, "First");
  assert.equal(f.writes(), 2);
});
test("wrong workspace/user/channel/thread/private scope rejects before reading question", async () => {
  for (const patch of [
    { teamId: "T2" },
    { userId: "U2" },
    { channelId: "C2" },
    { rootTs: "2.1" },
    { isDM: true, channelId: "D1" },
  ]) {
    const f = fixture();
    await assert.rejects(f.adapter.card({ ...binding, ...patch }));
    await assert.rejects(f.adapter.handle({ ...f.event("a".repeat(64)), ...patch }));
    assert.equal(f.reads(), 0);
    assert.equal(f.writes(), 0);
  }
});
test("changed canonical task/source and secret question never disclose", async () => {
  for (const patch of [
    { taskId: "SAV2-1" },
    { originRevision: "b".repeat(64) },
    { secret: true },
    { secret: undefined },
    { state: "unknown" },
  ]) {
    const f = fixture();
    Object.assign(f.q, patch);
    await assert.rejects(f.adapter.card(binding));
    assert.equal(f.writes(), 0);
  }
});
test("duplicate and concurrent delivery returns one canonical receipt without extra commit", async () => {
  const f = fixture(),
    c = await f.adapter.card(binding),
    e = f.event(c.token);
  const [a, b] = await Promise.all([f.adapter.handle(e), f.adapter.handle(e)]);
  assert.deepEqual(a, b);
  await f.adapter.handle(e);
  assert.equal(f.writes(), 1);
  assert.equal(f.events.length, 1);
});
test("conflicting repeated body and stale card cannot change a decision", async () => {
  const f = fixture(),
    c = await f.adapter.card(binding),
    e = f.event(c.token);
  await f.adapter.handle(e);
  await assert.rejects(f.adapter.handle({ ...e, text: e.text + "changed" }));
  await assert.rejects(f.adapter.handle(f.event(c.token, "answer", "Different", "Ev2")));
  assert.equal(f.writes(), 1);
});
test("lost canonical acknowledgment recovers original receipt through a fresh adapter", async () => {
  const f = fixture(),
    c = await f.adapter.card(binding),
    e = f.event(c.token);
  f.lose();
  await assert.rejects(f.adapter.handle(e), /lost acknowledgment/);
  const restart = createSlackDecisionQueue(policy, binding, f.port);
  const r = await restart.handle(e);
  assert.equal(r.receipt.version, 2);
  assert.equal(f.writes(), 1);
});
test("defer and skip suppress reminders until explicit human resume", async () => {
  for (const action of ["skip", "defer"]) {
    const f = fixture(),
      c = await f.adapter.card(binding);
    await f.adapter.handle(f.event(c.token, action, "Later"));
    const next = await f.adapter.card(binding);
    assert.equal(next.reminderEligible, false);
    await assert.rejects(f.adapter.handle(f.event(next.token, "answer", "First", "Ev2")));
    await f.adapter.handle(f.event(next.token, "resume", "Resume bounded question", "Ev3"));
    assert.equal(f.q.state, "open");
    assert.equal(f.q.answer, undefined);
  }
});
test("settled answers are preserved; only discussion remains available", async () => {
  const f = fixture();
  f.q.state = "answered";
  f.q.answer = "Original";
  const c = await f.adapter.card(binding);
  assert.equal(c.reminderEligible, false);
  assert.doesNotMatch(c.text, /decision answer/);
  await assert.rejects(f.adapter.handle(f.event(c.token)));
  await f.adapter.handle(f.event(c.token, "discuss", "More context"));
  assert.equal(f.q.answer, "Original");
});
test("unaccepted input, malformed command and unqualified receipt never dispatch", async () => {
  const f = fixture(),
    c = await f.adapter.card(binding);
  await assert.rejects(f.adapter.handle({ ...f.event(c.token), phase: "dispatching" }));
  for (const s of ["answer x yes", "decision answer bad yes", `decision answer ${c.token} `])
    assert.throws(() => parseDecisionCommand(s));
  const unsafe = createSlackDecisionQueue(policy, binding, {
    ...f.port,
    commit: async () => ({}),
  });
  await assert.rejects(unsafe.handle(f.event(c.token)), /Unknown canonical/);
  assert.equal(f.writes(), 0);
});
test("existing router reserves decisions so uncommissioned input cannot fall through to agent prompt", async () => {
  const commandCode = (await readFile(new URL("./commands.ts", import.meta.url), "utf8")).replace(
    'from "./conversations.js"',
    `from ${JSON.stringify(storeURL)}`,
  );
  const { parseSlackCommand } = await import(uri(commandCode));
  assert.equal(parseSlackCommand("decision answer something").kind, "decision-unconfigured");
  const runner = await readFile(new URL("./runner.ts", import.meta.url), "utf8");
  const commandURL = uri(commandCode),
    outputURL = uri(await readFile(new URL("./output.ts", import.meta.url), "utf8")),
    questionURL = uri(
      (await readFile(new URL("./questions.ts", import.meta.url), "utf8"))
        .replace('from "zod"', `from ${zod}`)
        .replace('from "./conversations.js"', `from ${JSON.stringify(storeURL)}`),
    ),
    daemonURL = uri(
      'export class SlackDaemon {} export function stableOperationId(){throw Error("Unexpected daemon access")}',
    );
  let actual = runner;
  for (const [name, url] of [
    ["./commands.js", commandURL],
    ["./conversations.js", storeURL],
    ["./daemon.js", daemonURL],
    ["./output.js", outputURL],
    ["./questions.js", questionURL],
  ])
    actual = actual.replace(`from "${name}"`, `from ${JSON.stringify(url)}`);
  const { ConversationRunner } = await import(uri(actual));
  const instance = new ConversationRunner({});
  await assert.rejects(
    instance.command({}, parseSlackCommand("decision answer something")),
    /not commissioned/,
  );
  assert.equal(parseSlackCommand("status").kind, "status");
});

const reservedVariants = [
  "decision",
  "decision answer",
  " decision answer bad yes",
  "\t\ndecision\tanswer bad yes",
  "decision\nanswer bad yes",
  "host=primary decision answer bad yes",
  "project=fixture decision answer bad yes",
  "host=primary project=fixture decision answer bad yes",
  "project=fixture\thost=primary\ndecision\tanswer bad yes",
  " \thost=primary\n project=fixture\t decision\nanswer bad yes",
  "host=INVALID decision answer bad yes",
  "host= decision answer bad yes",
  "host=primary host=secondary decision answer bad yes",
  "host=primary decision ???",
];
async function actualRouterFixture() {
  const original = process.env.DQ_PARSER_PREDECESSOR_FILE
    ? await readFile(process.env.DQ_PARSER_PREDECESSOR_FILE, "utf8")
    : await readFile(new URL("./commands.ts", import.meta.url), "utf8");
  const commandCode = original.replace(
      'from "./conversations.js"',
      `from ${JSON.stringify(storeURL)}`,
    ),
    commandURL = uri(commandCode);
  const daemon = await readFile(new URL("./daemon.ts", import.meta.url), "utf8"),
    stable = daemon.match(/export function stableOperationId[\s\S]*?\n}/)?.[0];
  assert.ok(stable);
  const modules = {
    "./commands.js": commandURL,
    "./conversations.js": storeURL,
    "./daemon.js": uri(
      'import { createHash } from "node:crypto"; export class SlackDaemon {}\n' + stable,
    ),
    "./output.js": uri(await readFile(new URL("./output.ts", import.meta.url), "utf8")),
    "./questions.js": uri(
      (await readFile(new URL("./questions.ts", import.meta.url), "utf8"))
        .replace('from "zod"', `from ${zod}`)
        .replace('from "./conversations.js"', `from ${JSON.stringify(storeURL)}`),
    ),
  };
  let runner = await readFile(new URL("./runner.ts", import.meta.url), "utf8");
  for (const [name, url] of Object.entries(modules))
    runner = runner.replace(`from "${name}"`, `from ${JSON.stringify(url)}`);
  return {
    ...(await import(commandURL)),
    ...(await import(uri(runner))),
    ...(await import(storeURL)),
  };
}
test("decision reservation survives selectors, whitespace and malformed decision syntax without rewriting input", async () => {
  const { parseSlackCommand } = await actualRouterFixture();
  for (const text of reservedVariants) {
    const original = text;
    assert.equal(parseSlackCommand(text).kind, "decision-unconfigured", JSON.stringify(text));
    assert.equal(text, original);
  }
  for (const text of [
    "Discuss a decision later",
    "decisioning is not a command",
    "host=primary build a decision report",
    "  ordinary body with spaces  ",
  ]) {
    const parsed = parseSlackCommand(text);
    assert.equal(parsed.kind, "prompt");
    assert.equal(parsed.text, text.startsWith("host=") ? "build a decision report" : text);
  }
});
test("actual runner tick and real persisted journal refuse every reserved variant with zero daemon/create/prompt/send calls", async () => {
  const { ConversationRunner, ConversationStore } = await actualRouterFixture(),
    { mkdtemp, rm } = await import("node:fs/promises"),
    { tmpdir } = await import("node:os"),
    { join } = await import("node:path");
  for (const text of reservedVariants) {
    const directory = await mkdtemp(join(tmpdir(), "slack-decision-router-")),
      controller = new AbortController(),
      calls = [],
      failures = [];
    try {
      const target = {
          host: "primary",
          project: "fixture",
          projectId: "project",
          cwd: "/fixture",
          serverId: "srv",
        },
        runnerPolicy = { ...policy, targets: [target] },
        store = await ConversationStore.open(directory, runnerPolicy);
      await store.accept({
        id: "Ev-reserved",
        teamId: "T1",
        userId: "U1",
        channelId: "C1",
        rootTs: "1.1",
        messageTs: "1.2",
        isDM: false,
        text,
      });
      const daemon = new Proxy(
        {},
        {
          get(_target, name) {
            return async () => {
              calls.push(String(name));
              throw Error("Unexpected daemon/provider access");
            };
          },
        },
      );
      const instance = new ConversationRunner({
        config: { policy: runnerPolicy },
        store,
        hosts: new Map([["primary", daemon]]),
        signal: controller.signal,
        failure: (failureCode) => failures.push(failureCode),
      });
      await instance.tick();
      assert.deepEqual(calls, [], JSON.stringify(text));
      assert.equal(store.pending().length, 0, JSON.stringify(text));
      assert.deepEqual(store.bindings(), []);
      assert.deepEqual(failures, ["slack_operation_refused"]);
      const outputs = store.deliveries();
      assert.equal(outputs.length, 1);
      assert.match(outputs[0].text, /not commissioned/);
      assert.equal(outputs[0].phase, "pending");
      const journal = JSON.parse(await readFile(join(directory, "conversations.json"), "utf8"));
      assert.equal(journal.intake[0].text, text);
      assert.equal(journal.intake[0].messageTs, "1.2");
      assert.equal(journal.intake[0].phase, "completed");
    } finally {
      controller.abort();
      await rm(directory, { recursive: true, force: true });
    }
  }
});
