import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes, createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const read = (n) => fs.readFile(new URL(n, import.meta.url), "utf8"),
  uri = (s) =>
    "data:text/javascript;base64," +
    Buffer.from(stripTypeScriptTypes(s, { mode: "transform" })).toString(
      "base64",
    ),
  hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex"),
  require = createRequire(
    (process.env.DQ_TEST_PACKAGE_ROOT || process.cwd()) + "/package.json",
  ),
  zod = JSON.stringify(pathToFileURL(require.resolve("zod")).href),
  storeURL = uri(
    (await read("./conversations.ts")).replace('from "zod"', `from ${zod}`),
  ),
  queueURL = uri(
    (await read("./decision-queue.ts")).replace(
      'from "./conversations.js"',
      `from ${JSON.stringify(storeURL)}`,
    ),
  ),
  portURL = uri(
    (await read("./canonical-slack-port.ts"))
      .replace('from "./conversations.js"', `from ${JSON.stringify(storeURL)}`)
      .replace(
        'from "./decision-queue.js"',
        `from ${JSON.stringify(queueURL)}`,
      ),
  );
const { ConversationStore } = await import(storeURL),
  { createSlackDecisionQueue, decisionToken } = await import(queueURL),
  { createCanonicalSlackPort, readAcceptedSlackSource } = await import(portURL);
async function fixture() {
  const root = await fs.realpath(
      await fs.mkdtemp(join(tmpdir(), "canonical-slack-")),
    ),
    journalRoot = join(root, "bridge"),
    configPath = join(root, "receiver.json"),
    journalPath = join(journalRoot, "conversations.json"),
    receiver = {
      teamId: "T1",
      userIds: ["U1"],
      channelIds: ["C1"],
      allowDMs: false,
      targets: [
        {
          host: "primary",
          project: "fixture",
          projectId: "p1",
          cwd: "/fixture",
          serverId: "srv1",
        },
      ],
    },
    binding = {
      teamId: "T1",
      channelId: "C1",
      rootTs: "1.1",
      userId: "U1",
      isDM: false,
      questionId: "original-q",
      taskId: "SAV2-1357",
      originRevision: "a".repeat(64),
      disclosureApproved: true,
    },
    q = {
      id: "original-q",
      question: "Original fixture question?",
      context: "Original options/context retained",
      options: ["First", "Custom"],
      recommended: 0,
      status: "open",
      answer: null,
      filedAt: "2026-10-18T12:00:00Z",
      answeredAt: null,
      fromAgentId: null,
      fromLabel: "Fixture",
      retainedUnknown: { keep: true },
      decisionLoop: {
        version: 1,
        origin: {
          platform: "fixture",
          account: "local",
          session: "original",
          message: "q",
          revision: "a".repeat(64),
          item: "q",
        },
        taskId: "SAV2-1357",
        planPath: join(root, "plan.md"),
        protected: true,
        state: "open",
        events: [
          {
            id: "original-file",
            digest: "original",
            type: "file",
            at: "2026-10-18T12:00:00Z",
            actor: {
              kind: "human",
              identity: "fixture",
              source: {
                platform: "fixture",
                account: "local",
                session: "original",
                message: "q",
                revision: "a".repeat(64),
                item: "q",
              },
              reference: "fixture:original",
            },
          },
        ],
      },
    };
  const configBytes = Buffer.from(
    JSON.stringify({ appId: "A1", policy: receiver }),
  );
  await fs.writeFile(configPath, configBytes, { mode: 0o600 });
  const journalStore = await ConversationStore.open(journalRoot, receiver),
    token = decisionToken(binding, {
      id: q.id,
      taskId: binding.taskId,
      originRevision: binding.originRevision,
      version: 1,
    }),
    text = `decision answer ${token} Keep the exact custom answer.  `;
  await journalStore.accept({
    id: "Ev1",
    teamId: "T1",
    userId: "U1",
    channelId: "C1",
    rootTs: "1.1",
    messageTs: "1.2",
    text,
    isDM: false,
  });
  let event = journalStore.pending()[0];
  const revision = hash({
    id: event.id,
    teamId: event.teamId,
    userId: event.userId,
    channelId: event.channelId,
    rootTs: event.rootTs,
    messageTs: event.messageTs,
    text: event.text,
    isDM: event.isDM,
    receivedAt: event.receivedAt,
  });
  const policy = {
    ownerUid: process.getuid(),
    journalRoot,
    journalPath,
    configRoot: root,
    configPath,
    configSha256: createHash("sha256").update(configBytes).digest("hex"),
    appId: "A1",
    binding,
    admissions: [
      {
        originalEventId: "Ev1",
        revision,
        expectedVersion: 1,
        action: "answer",
      },
    ],
  };
  let rows = [structuredClone(q)],
    writes = 0,
    serial = Promise.resolve(),
    lost = false,
    before = false;
  const canonical = {
    async read() {
      return structuredClone(rows);
    },
    mutate(fn) {
      const p = serial.then(() => {
        const n = fn(structuredClone(rows));
        if (before) {
          before = false;
          throw Error("precommit failure");
        }
        rows = n.questions;
        writes++;
        if (lost) {
          lost = false;
          throw Error("lost acknowledgment");
        }
        return n.result;
      });
      serial = p.catch(() => {});
      return p;
    },
    transition(rows, e) {
      const next = structuredClone(rows),
        q = next.find((q) => q.id === e.questionId);
      assert.equal(q.decisionLoop.version, e.expectedVersion);
      q.decisionLoop.version++;
      q.decisionLoop.events.push({
        id: e.id,
        type: e.type,
        requestDigest: e.requestDigest,
        actor: e.actor,
        text: e.text,
      });
      q.answer = e.text;
      q.status = "answered";
      q.decisionLoop.state = "answered";
      return next;
    },
  };
  const make = () => createCanonicalSlackPort(policy, canonical),
    port = make(),
    adapter = createSlackDecisionQueue(receiver, binding, port),
    source = readAcceptedSlackSource(policy, "Ev1"),
    request = {
      eventId: source.eventId,
      eventDigest: source.eventDigest,
      questionId: q.id,
      expectedVersion: 1,
      taskId: binding.taskId,
      originRevision: binding.originRevision,
      action: "answer",
      text: "Keep the exact custom answer.  ",
      source: {
        platform: "slack",
        account: "T1",
        channel: "C1",
        rootTs: "1.1",
        message: "1.2",
        actor: "U1",
      },
    };
  const change = async (fn) => {
    const j = JSON.parse(await fs.readFile(journalPath, "utf8"));
    fn(j);
    await fs.writeFile(journalPath, JSON.stringify(j));
  };
  return {
    root,
    policy,
    canonical,
    make,
    port,
    adapter,
    event,
    request,
    q,
    change,
    writes: () => writes,
    rows: () => structuredClone(rows),
    setRows: (x) => (rows = x),
    lose: () => (lost = true),
    failBefore: () => (before = true),
    close: () => fs.rm(root, { recursive: true, force: true }),
  };
}
const use = async (fn) => {
  const f = await fixture();
  try {
    await fn(f);
  } finally {
    await f.close();
  }
};
test("accepted actual Slack journal source commits once through supplied canonical transaction, preserving exact evidence", () =>
  use(async (f) => {
    const out = await f.adapter.handle(f.event);
    assert.equal(out.dispatchAllowed, false);
    assert.equal(f.writes(), 1);
    const q = f.rows()[0];
    assert.equal(q.id, "original-q");
    assert.deepEqual(q.retainedUnknown, { keep: true });
    assert.equal(q.answer, "Keep the exact custom answer.  ");
    assert.equal(q.decisionLoop.events[1].actor.source.platform, "slack");
    assert.equal(q.decisionLoop.events[1].actor.source.message, "1.2");
    assert.equal(q.decisionSlackReceipts.length, 1);
  }));
test("known/concurrent replay and restart return one same-store receipt without a no-op write", () =>
  use(async (f) => {
    const [a, b] = await Promise.all([
      f.port.commit(f.request),
      f.port.commit(f.request),
    ]);
    assert.deepEqual(a, b);
    assert.equal(f.writes(), 1);
    await f.make().commit(f.request);
    assert.equal(f.writes(), 1);
  }));
test("precommit failure and lost acknowledgment recover from existing canonical receipt without duplicate transition", () =>
  use(async (f) => {
    f.failBefore();
    await assert.rejects(f.port.commit(f.request), /precommit/);
    assert.equal(f.writes(), 0);
    f.lose();
    await assert.rejects(f.port.commit(f.request), /lost acknowledgment/);
    await f.make().commit(f.request);
    assert.equal(f.writes(), 1);
    assert.equal(f.rows()[0].decisionLoop.events.length, 2);
  }));
for (const [name, mutate] of Object.entries({
  actor: (j) => (j.intake[0].userId = "U2"),
  workspace: (j) => (j.intake[0].teamId = "T2"),
  channel: (j) => (j.intake[0].channelId = "C2"),
  thread: (j) => (j.intake[0].rootTs = "2.1"),
  message: (j) => (j.intake[0].messageTs = "2.2"),
  text: (j) => (j.intake[0].text += "edited"),
  phase: (j) => (j.intake[0].phase = "dispatching"),
  duplicate: (j) => j.intake.push(structuredClone(j.intake[0])),
}))
  test("independently refuses denied/edited original " + name, () =>
    use(async (f) => {
      await f.change(mutate);
      await assert.rejects(f.port.commit(f.request));
      assert.equal(f.writes(), 0);
    }),
  );
test("receiver app/config drift, no disclosure admission, symlink and unsafe evidence permissions fail closed", () =>
  use(async (f) => {
    const p = structuredClone(f.policy);
    p.appId = "other";
    assert.throws(() => readAcceptedSlackSource(p, "Ev1"));
    p.appId = "A1";
    p.binding.disclosureApproved = false;
    await assert.rejects(
      createCanonicalSlackPort(p, f.canonical).read("original-q"),
    );
    const link = join(f.root, "journal-link");
    await fs.symlink(f.policy.journalPath, link);
    assert.throws(() =>
      readAcceptedSlackSource({ ...f.policy, journalPath: link }, "Ev1"),
    );
    await fs.chmod(f.policy.journalPath, 0o644);
    assert.throws(() => readAcceptedSlackSource(f.policy, "Ev1"));
    assert.equal(f.writes(), 0);
  }));
test("changed task/origin, secret records and stale versions never mutate canonical data", () =>
  use(async (f) => {
    for (const patch of [
      { taskId: "SAV2-1" },
      { origin: { revision: "b".repeat(64) } },
      { version: 2 },
    ]) {
      const q = structuredClone(f.q);
      Object.assign(q.decisionLoop, patch);
      f.setRows([q]);
      await assert.rejects(f.port.commit(f.request));
      assert.equal(f.writes(), 0);
    }
    f.setRows([{ ...structuredClone(f.q), secret: true }]);
    await assert.rejects(f.port.read("original-q"));
  }));
test("caller-supplied forged answer or actor cannot override the independently read source, even after known receipt", () =>
  use(async (f) => {
    for (const patch of [
      { text: "Approve something else" },
      { source: { ...f.request.source, actor: "U2" } },
    ])
      await assert.rejects(f.port.commit({ ...f.request, ...patch }));
    await f.port.commit(f.request);
    await assert.rejects(
      f.port.commit({ ...f.request, text: "Edited replay" }),
    );
    assert.equal(f.writes(), 1);
  }));
test("source is checked again under the canonical lock and accepted-to-completed journal phase preserves original revision", () =>
  use(async (f) => {
    const mutate = f.canonical.mutate;
    f.canonical.mutate = async (fn) => {
      await f.change((j) => (j.intake[0].text += "changed-before-commit"));
      return mutate(fn);
    };
    await assert.rejects(f.port.commit(f.request));
    assert.equal(f.writes(), 0);
  }));
test("ordinary journal completion does not fabricate a new human answer or break original receipt replay", () =>
  use(async (f) => {
    await f.port.commit(f.request);
    await f.change((j) => (j.intake[0].phase = "completed"));
    await f.make().commit(f.request);
    assert.equal(f.writes(), 1);
  }));

test("changed receiver config bytes and a different OS evidence owner are denied before any canonical write", () =>
  use(async (f) => {
    assert.throws(() =>
      readAcceptedSlackSource(
        { ...f.policy, ownerUid: f.policy.ownerUid + 1 },
        "Ev1",
      ),
    );
    await fs.appendFile(f.policy.configPath, "\n");
    assert.throws(
      () => readAcceptedSlackSource(f.policy, "Ev1"),
      /configuration changed/,
    );
    await assert.rejects(f.port.commit(f.request));
    assert.equal(f.writes(), 0);
  }));
