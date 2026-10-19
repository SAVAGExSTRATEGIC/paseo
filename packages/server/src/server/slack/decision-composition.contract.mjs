import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
const uri = (s) =>
    "data:text/javascript;base64," +
    Buffer.from(stripTypeScriptTypes(s, { mode: "transform" })).toString("base64"),
  url = new URL("./canonical-slack-port.contract.mjs", import.meta.url).href;
let helpers = await fs.readFile(new URL(url), "utf8");
helpers = helpers
  .slice(0, helpers.search(/const use\s*=/))
  .replaceAll("import.meta.url", JSON.stringify(url));
const base = await import(
  "data:text/javascript;base64," +
    Buffer.from(helpers + "\nexport{fixture,uri,storeURL,queueURL,portURL,zod};").toString("base64")
);
const read = (n) => fs.readFile(new URL(n, import.meta.url), "utf8"),
  commandsURL = uri(
    (await read("./commands.ts")).replace(
      'from "./conversations.js"',
      `from ${JSON.stringify(base.storeURL)}`,
    ),
  ),
  compositionURL = uri(
    (await read("./decision-composition.ts"))
      .replace('from "./decision-queue.js"', `from ${JSON.stringify(base.queueURL)}`)
      .replace('from "./canonical-slack-port.js"', `from ${JSON.stringify(base.portURL)}`),
  ),
  { createSlackDecisionComposition } = await import(compositionURL),
  { decisionToken } = await import(base.queueURL),
  { ConversationStore } = await import(base.storeURL);
const ingressURL = uri(
    (await read("./ingress.ts"))
      .replace('from "zod"', `from ${base.zod}`)
      .replace('from "./conversations.js"', `from ${JSON.stringify(base.storeURL)}`),
  ),
  consumerURL = uri(
    (await read("./consumer.ts"))
      .replace('from "./conversations.js"', `from ${JSON.stringify(base.storeURL)}`)
      .replace('from "./ingress.js"', `from ${JSON.stringify(ingressURL)}`),
  ),
  { createSocketConsumer } = await import(consumerURL);
const daemon = await read("./daemon.ts"),
  stable = daemon.match(/export function stableOperationId[\s\S]*?\n}/)?.[0];
assert.ok(stable);
const replacements = {
  "./commands.js": commandsURL,
  "./conversations.js": base.storeURL,
  "./daemon.js": uri('import{createHash}from"node:crypto";export class SlackDaemon{};' + stable),
  "./output.js": uri(await read("./output.ts")),
  "./questions.js": uri(
    (await read("./questions.ts"))
      .replace('from "zod"', `from ${base.zod}`)
      .replace('from "./conversations.js"', `from ${JSON.stringify(base.storeURL)}`),
  ),
};
let runner = await read("./runner.ts");
for (const [n, u] of Object.entries(replacements))
  runner = runner.replace(`from "${n}"`, `from ${JSON.stringify(u)}`);
const { ConversationRunner } = await import(uri(runner));
async function composed() {
  const f = await base.fixture(),
    config = JSON.parse(await fs.readFile(f.policy.configPath, "utf8")),
    bridge = await ConversationStore.open(f.policy.journalRoot, config.policy);
  await bridge.finish("Ev1", []);
  const controller = new AbortController(),
    calls = [],
    failures = [];
  f.canonical.transition = (rows, e) => {
    const next = structuredClone(rows),
      q = next.find((candidate) => candidate.id === e.questionId),
      loop = q.decisionLoop;
    assert.equal(loop.version, e.expectedVersion);
    if (e.type === "answer") {
      if (q.answer) throw Error("preserve answer");
      q.answer = e.text;
      q.status = "answered";
      loop.state = "answered";
    } else if (e.type === "discuss") {
    } else if (e.type === "defer") loop.state = "deferred";
    else if (e.type === "skip") loop.state = "skipped";
    else if (e.type === "resume") loop.state = "open";
    loop.version++;
    loop.events.push({
      id: e.id,
      type: e.type,
      requestDigest: e.requestDigest,
      actor: e.actor,
      text: e.text,
    });
    return next;
  };
  const scope = {
    ...f.policy,
    allowedActions: ["answer", "discuss", "defer", "skip", "resume"],
  };
  delete scope.admissions;
  const make = () => createSlackDecisionComposition(scope, f.canonical),
    composition = make(),
    hosts = new Map([
      [
        "primary",
        new Proxy(
          {},
          {
            get(_t, name) {
              return async () => {
                calls.push(String(name));
                throw Error("Unexpected daemon access");
              };
            },
          },
        ),
      ],
    ]),
    newRunner = (queue) =>
      new ConversationRunner({
        config,
        store: bridge,
        hosts,
        signal: controller.signal,
        failure: (code) => failures.push(code),
        decisionQueue: queue,
      }),
    worker = newRunner(composition),
    consumer = createSocketConsumer({
      config: { ...config, botUserId: "B1" },
      store: bridge,
      state: () => {},
      failure: (code) => failures.push(code),
    });
  let seq = 10;
  const payload = (text, patch = {}) => ({
      type: "event_callback",
      api_app_id: "A1",
      team_id: "T1",
      event_id: "EvC" + seq,
      event: {
        type: "app_mention",
        user: "U1",
        channel: "C1",
        thread_ts: "1.1",
        ts: "1." + seq,
        text,
        ...patch,
      },
    }),
    emit = async (action = "answer", text = "Exact normalized answer", patch = {}) => {
      seq++;
      const q = (await f.canonical.read()).find((candidate) => candidate.id === "original-q"),
        token = decisionToken(scope.binding, {
          id: q.id,
          taskId: q.decisionLoop.taskId,
          originRevision: q.decisionLoop.origin.revision,
          version: q.decisionLoop.version,
        });
      const p = payload(`decision ${action} ${token} ${text}`, patch);
      await consumer.accept("events_api", p, "envelope-" + seq);
      return {
        payload: p,
        event: bridge.pending().find((e) => e.id === p.event_id),
      };
    };
  return {
    ...f,
    scope,
    config,
    bridge,
    worker,
    consumer,
    composition,
    make,
    newRunner,
    emit,
    payload,
    calls,
    failures,
    controller,
    close: async () => {
      controller.abort();
      await f.close();
    },
  };
}
const use = async (fn) => {
  const f = await composed();
  try {
    await fn(f);
  } finally {
    await f.close();
  }
};
test("actual receiver→persisted journal→runner→derived admission→canonical port commits one answer/receipt and no daemon/send", () =>
  use(async (f) => {
    const p = await f.emit(),
      raw = JSON.stringify(p.payload);
    await f.worker.tick();
    assert.equal(f.writes(), 1);
    assert.equal(f.bridge.pending().length, 0);
    const q = f.rows()[0];
    assert.equal(q.answer, "Exact normalized answer");
    assert.equal(q.decisionSlackReceipts.length, 1);
    assert.equal(q.decisionLoop.events[1].actor.source.platform, "slack");
    assert.equal(q.decisionLoop.events[1].actor.source.item, p.payload.event_id);
    assert.equal(JSON.stringify(p.payload), raw);
    assert.deepEqual(f.calls, []);
    assert.match(f.bridge.deliveries()[0].text, /No session was resumed/);
  }));
test("duplicate receiver event and fresh composition replay never create a second answer/receipt", () =>
  use(async (f) => {
    const p = await f.emit();
    await f.worker.tick();
    await f.consumer.accept("events_api", p.payload, "duplicate-envelope");
    await f.newRunner(f.make()).tick();
    await f.make().handle(p.event);
    assert.equal(f.writes(), 1);
    assert.equal(f.rows()[0].decisionSlackReceipts.length, 1);
    assert.deepEqual(f.calls, []);
  }));
for (const [name, patch] of Object.entries({
  actor: { user: "U2" },
  channel: { channel: "C2" },
  thread: { thread_ts: "2.1" },
  bot: { user: "B1" },
  edited: { subtype: "message_changed" },
}))
  test("actual receiver/composition rejects " + name + " with zero canonical/daemon effects", () =>
    use(async (f) => {
      await f.emit("answer", "Denied", patch);
      await f.worker.tick();
      assert.equal(f.writes(), 0);
      assert.deepEqual(f.calls, []);
    }),
  );
test("wrong app and workspace payloads never reach a canonical transition", () =>
  use(async (f) => {
    for (const patch of [{ api_app_id: "A2" }, { team_id: "T2" }]) {
      const p = await f.emit();
      await f.bridge.finish(p.event.id, []);
      p.payload.event_id += "-denied";
      Object.assign(p.payload, patch);
      await f.consumer.accept("events_api", p.payload, "denied-envelope");
    }
    await f.worker.tick();
    assert.equal(f.writes(), 0);
    assert.deepEqual(f.calls, []);
  }));
for (const text of [
  "ordinary text is not an answer",
  "decision answer bad yes",
  "host=primary decision answer bad yes",
])
  test("scoped runner does not turn " + JSON.stringify(text) + " into agent work", () =>
    use(async (f) => {
      const p = await f.emit();
      await f.bridge.finish(p.event.id, []);
      p.payload.event_id += "-input";
      p.payload.event.text = text;
      await f.consumer.accept("events_api", p.payload, "malformed");
      await f.worker.tick();
      assert.equal(f.writes(), 0);
      assert.deepEqual(f.calls, []);
    }),
  );
test("caller edits and cross-question tokens cannot manufacture admission", () =>
  use(async (f) => {
    const p = await f.emit();
    await assert.rejects(f.composition.handle({ ...p.event, text: p.event.text + "changed" }));
    await f.bridge.finish(p.event.id, []);
    for (const token of [
      "a".repeat(64),
      decisionToken(
        { ...f.scope.binding, questionId: "other" },
        {
          id: "other",
          taskId: "SAV2-1357",
          originRevision: "a".repeat(64),
          version: 1,
        },
      ),
    ]) {
      const next = {
        ...p.payload,
        event_id: p.payload.event_id + token.slice(0, 4),
        event: { ...p.payload.event, text: `decision answer ${token} no` },
      };
      await f.consumer.accept("events_api", next, "bad-token");
      await f.worker.tick();
    }
    assert.equal(f.writes(), 0);
    assert.deepEqual(f.calls, []);
  }));
test("unknown ack retains input and restarted runner uses read-only receipt recovery without another commit", () =>
  use(async (f) => {
    await f.emit();
    f.lose();
    await f.worker.tick();
    assert.equal(f.writes(), 1);
    assert.equal(f.bridge.pending()[0].phase, "needs_attention");
    await f.newRunner(f.make()).tick();
    assert.equal(f.bridge.pending().length, 0);
    assert.equal(f.writes(), 1);
    assert.equal(f.rows()[0].decisionSlackReceipts.length, 1);
    assert.deepEqual(f.calls, []);
  }));
test("uncertain precommit without a receipt stays retained after restart and is never blindly replayed", () =>
  use(async (f) => {
    await f.emit();
    f.failBefore();
    await f.worker.tick();
    assert.equal(f.writes(), 0);
    const pending = f.bridge.pending()[0];
    assert.equal(pending.phase, "needs_attention");
    await f.newRunner(f.make()).tick();
    await assert.rejects(f.make().handle(pending));
    assert.equal(f.bridge.pending()[0].phase, "needs_attention");
    assert.equal(f.writes(), 0);
    assert.deepEqual(f.calls, []);
  }));
test("derived admissions keep discussion/defer/skip/resume/answer semantics across actual entrypoints", () =>
  use(async (f) => {
    for (const action of ["discuss", "defer", "resume", "skip", "resume", "answer"]) {
      await f.emit(action, action + " original human text");
      await f.worker.tick();
      const q = f.rows()[0];
      const expectedStates = { defer: "deferred", skip: "skipped", answer: "answered" };
      assert.equal(q.decisionLoop.state, expectedStates[action] ?? "open");
      if (action !== "answer") assert.equal(q.answer, null);
    }
    assert.equal(f.writes(), 6);
    assert.equal(f.rows()[0].decisionSlackReceipts.length, 6);
    assert.equal(f.rows()[0].decisionLoop.events.filter((e) => e.type === "answer").length, 1);
    assert.deepEqual(f.calls, []);
  }));

test("valid old-version token is refused after a concurrent canonical version change", () =>
  use(async (f) => {
    await f.emit();
    const q = f.rows()[0];
    q.decisionLoop.version = 2;
    f.setRows([q]);
    await f.worker.tick();
    assert.equal(f.writes(), 0);
    assert.deepEqual(f.calls, []);
  }));
test("fixed approved action scope cannot be widened by a real accepted caller", () =>
  use(async (f) => {
    await f.emit("answer");
    const limited = createSlackDecisionComposition(
      { ...f.scope, allowedActions: ["discuss"] },
      f.canonical,
    );
    await f.newRunner(limited).tick();
    assert.equal(f.writes(), 0);
    assert.deepEqual(f.calls, []);
  }));
test("completed input without a canonical receipt is not new commit authority", () =>
  use(async (f) => {
    const p = await f.emit();
    await f.bridge.finish(p.event.id, []);
    await assert.rejects(f.make().handle(p.event));
    assert.equal(await f.make().recover(p.event), null);
    assert.equal(f.writes(), 0);
    assert.deepEqual(f.calls, []);
  }));
