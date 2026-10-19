import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { createHash } from "node:crypto";
const uri = (s) =>
    "data:text/javascript;base64," +
    Buffer.from(stripTypeScriptTypes(s, { mode: "transform" })).toString(
      "base64",
    ),
  read = (n) => fs.readFile(new URL(n, import.meta.url), "utf8"),
  sha = (b) => createHash("sha256").update(b).digest("hex");
const helperURL = new URL(
  "./decision-composition.contract.mjs",
  import.meta.url,
).href;
let helpers = await fs.readFile(new URL(helperURL), "utf8");
helpers = helpers
  .slice(0, helpers.search(/const use\s*=/))
  .replace(/,\s*import\.meta\.url\)/g, ", " + JSON.stringify(helperURL) + ")");
helpers = helpers.replace(
  "const { ConversationRunner } = await import(uri(runner));",
  "const runnerURL=uri(runner); const { ConversationRunner } = await import(runnerURL);",
);
const base = await import(
  "data:text/javascript;base64," +
    Buffer.from(
      helpers +
        "\nexport{composed,compositionURL,runnerURL};export const zod=base.zod,storeURL=base.storeURL;",
    ).toString("base64")
);
// Load the actual bootstrap with only package/relative import resolution changed.
let bootstrap = await read("./decision-bootstrap.ts");
bootstrap = bootstrap
  .replace('from "zod"', `from ${base.zod}`)
  .replace('from "./conversations.js"', `from ${JSON.stringify(base.storeURL)}`)
  .replace(
    'from "./decision-composition.js"',
    `from ${JSON.stringify(base.compositionURL)}`,
  );
const bootURL = uri(bootstrap),
  { loadDecisionBootstrap } = await import(bootURL);
export async function bootFixture(bundleCode) {
  const f = await base.composed(),
    canonicalHome = join(f.root, "canonical-home"),
    sourceRoot = join(f.root, "approved-source"),
    stageRoot = join(f.root, "stage");
  for (const p of [
    canonicalHome,
    sourceRoot,
    stageRoot,
    join(canonicalHome, "savage-bots"),
    join(sourceRoot, "server"),
    join(sourceRoot, "shared"),
  ])
    await fs.mkdir(p, { mode: 0o700 });
  const qpath = join(canonicalHome, "savage-bots/questions.json");
  await fs.writeFile(qpath, JSON.stringify([f.q]), { mode: 0o600 });
  const sources = {};
  for (const n of [
    "server/store.ts",
    "server/decision-loop.ts",
    "shared/bots.ts",
  ]) {
    const b = Buffer.from("approved source fixture " + n);
    await fs.writeFile(join(sourceRoot, n), b, { mode: 0o600 });
    sources[n] = sha(b);
  }
  const bundle = join(stageRoot, "canonical.mjs");
  await fs.writeFile(
    bundle,
    bundleCode ??
      `import fs from 'node:fs/promises';import assert from 'node:assert/strict';export const botsRootDir=${JSON.stringify(join(canonicalHome, "savage-bots"))};export async function readQuestions(){return JSON.parse(await fs.readFile(${JSON.stringify(qpath)},'utf8'))};export async function mutateQuestions(fn){const next=fn(await readQuestions());await fs.writeFile(${JSON.stringify(qpath)},JSON.stringify(next.questions));return next.result};export const transitionQuestions=${f.canonical.transition.toString()};`,
    { mode: 0o600 },
  );
  const manifest = {
    version: 1,
    enabled: true,
    release: "b".repeat(40),
    ownerUid: process.getuid(),
    configPath: f.policy.configPath,
    configSha256: f.policy.configSha256,
    stageRoot,
    canonicalSourceRoot: sourceRoot,
    canonicalHome,
    sources,
    bundleSha256: sha(await fs.readFile(bundle)),
    scope: f.scope ?? {
      ...f.policy,
      allowedActions: ["answer", "discuss", "defer", "skip", "resume"],
    },
  };
  delete manifest.scope.admissions;
  const file = join(f.root, "bootstrap.json"),
    config = JSON.parse(await fs.readFile(f.policy.configPath));
  let pin;
  const save = async () => {
    await fs.writeFile(file, JSON.stringify(manifest), { mode: 0o600 });
    pin = sha(await fs.readFile(file));
  };
  await save();
  const prior = process.env.PASEO_HOME;
  process.env.PASEO_HOME = canonicalHome;
  const input = () => ({
    configFile: f.policy.configPath,
    config,
    release: manifest.release,
    environment: {
      PASEO_HOME: canonicalHome,
      PASEO_SLACK_DECISION_MANIFEST: file,
      PASEO_SLACK_DECISION_MANIFEST_SHA256: pin,
    },
  });
  return Object.assign(f, {
    manifest,
    file,
    sourceRoot,
    stageRoot,
    canonicalHome,
    qpath,
    bundle,
    config,
    save,
    input,
    load: () => loadDecisionBootstrap(input()),
    async close() {
      if (prior === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = prior;
      await fs.rm(f.root, { recursive: true, force: true });
    },
  });
}
const use = (fn) => async () => {
  const f = await bootFixture();
  try {
    await fn(f);
  } finally {
    await f.close();
  }
};
test("default disabled performs no canonical root or module access", async () => {
  assert.equal(
    await loadDecisionBootstrap({
      configFile: "/does-not-exist",
      config: {},
      release: "x",
      environment: {},
    }),
    undefined,
  );
});
test(
  "pinned disabled marker ignores unavailable canonical paths",
  use(async (f) => {
    f.manifest.enabled = false;
    f.manifest.canonicalHome = "/missing";
    await f.save();
    assert.equal(await f.load(), undefined);
  }),
);
for (const name of [
  "missing-pin",
  "manifest-drift",
  "wrong-release",
  "wrong-owner",
  "wrong-app",
  "wrong-config",
  "wrong-home",
  "missing-store",
  "wrong-source",
  "bundle-drift",
  "symlink-bundle",
  "public-manifest",
  "unapproved-disclosure",
  "wrong-actor",
  "wrong-root-export",
])
  test(
    "startup refuses " + name,
    use(async (f) => {
      let input = f.input();
      if (name === "missing-pin")
        delete input.environment.PASEO_SLACK_DECISION_MANIFEST_SHA256;
      else if (name === "manifest-drift") await fs.appendFile(f.file, " ");
      else if (name === "wrong-release") input.release = "c".repeat(40);
      else if (name === "wrong-owner") f.manifest.ownerUid++;
      else if (name === "wrong-app") f.manifest.scope.appId = "A2";
      else if (name === "wrong-config")
        await fs.appendFile(f.policy.configPath, " ");
      else if (name === "wrong-home") input.environment.PASEO_HOME = "/missing";
      else if (name === "missing-store") await fs.unlink(f.qpath);
      else if (name === "wrong-source")
        await fs.appendFile(join(f.sourceRoot, "server/store.ts"), "drift");
      else if (name === "bundle-drift")
        await fs.appendFile(f.bundle, "\n//drift");
      else if (name === "symlink-bundle") {
        await fs.rename(f.bundle, f.bundle + ".saved");
        await fs.symlink(f.bundle + ".saved", f.bundle);
      } else if (name === "public-manifest") await fs.chmod(f.file, 0o644);
      else if (name === "unapproved-disclosure")
        f.manifest.scope.binding.disclosureApproved = false;
      else if (name === "wrong-actor") f.manifest.scope.binding.userId = "U2";
      else if (name === "wrong-root-export") {
        await fs.writeFile(f.bundle, 'export const botsRootDir="/wrong";');
        f.manifest.bundleSha256 = sha(await fs.readFile(f.bundle));
      }
      if (
        [
          "wrong-owner",
          "wrong-app",
          "unapproved-disclosure",
          "wrong-actor",
          "wrong-root-export",
        ].includes(name)
      ) {
        await f.save();
        input = f.input();
      }
      await assert.rejects(loadDecisionBootstrap(input));
      assert.deepEqual(f.calls, []);
    }),
  );
test(
  "actual bootstrap commits once and restarted capability recovers receipt",
  use(async (f) => {
    const p = await f.emit(),
      queue = await f.load();
    await f.newRunner(queue).tick();
    let rows = JSON.parse(await fs.readFile(f.qpath));
    assert.equal(rows[0].decisionSlackReceipts.length, 1);
    const before = await fs.readFile(f.qpath);
    assert.ok(await (await f.load()).recover(p.event));
    await f.newRunner(await f.load()).tick();
    assert.deepEqual(await fs.readFile(f.qpath), before);
    assert.deepEqual(f.calls, []);
  }),
);
test(
  "root drift after startup refuses before canonical write",
  use(async (f) => {
    const queue = await f.load();
    await f.emit();
    await fs.appendFile(join(f.sourceRoot, "server/store.ts"), "changed");
    const before = await fs.readFile(f.qpath);
    await f.newRunner(queue).tick();
    assert.deepEqual(await fs.readFile(f.qpath), before);
    assert.deepEqual(f.calls, []);
  }),
);
// Execute actual main.runBridge with dependency boundaries replaced; no sockets/daemon/network.
export async function mainHarness(f) {
  f.config.hosts = [{ name: "primary" }];
  const calls = [];
  globalThis.__bootstrapMain = {
    calls,
    config: f.config,
    store: f.bridge,
    controller: new AbortController(),
  };
  const u = uri(
    `const s=globalThis.__bootstrapMain;export const readBridgeConfig=async()=>s.config;export const requireSecret=(_e,k)=>k==='PASEO_SLACK_RELEASE'?'b'.repeat(40):'fictional';export class SlackApi{async verifyIdentity(){s.calls.push('identity')}};export const acquirePidLock=async()=>s.calls.push('lock');export const releasePidLock=async()=>s.calls.push('unlock');export const startPidLockHeartbeat=()=>()=>{};export const createBridgeLog=async()=>({log(){},close:async()=>{}});export const backupJournal=async()=>{};export const ConversationStore={open:async()=>s.store};export class SlackPolicyError extends Error{};export class SlackDaemon{async connect(){}async verifyTarget(){}async close(){}};export const stableOperationId=(_n,id)=>id;export const serveHealth=async()=>({close:async()=>{}});export class SlackOutbox{async flush(){s.calls.push('outbox-boundary');s.controller.abort()}};export const createSocketConsumer=()=>({});export const runSocketMode=async()=>{s.calls.push('socket-boundary')};` +
      "\nvoid " +
      JSON.stringify(f.root + Math.random()) +
      ";",
  );
  let main = await read("./main.ts");
  main = main.replace(/from "\.\.?\/[^"\n]+"/g, (m) =>
    m.includes("runner.js")
      ? `from ${JSON.stringify(base.runnerURL)}`
      : m.includes("decision-bootstrap.js")
        ? `from ${JSON.stringify(bootURL)}`
        : `from ${JSON.stringify(u)}`,
  );
  const module = await import(uri(main + "\n//" + f.root));
  return {
    calls,
    async run() {
      const old = {};
      for (const [k, v] of Object.entries(f.input().environment)) {
        old[k] = process.env[k];
        process.env[k] = v;
      }
      const controller = globalThis.__bootstrapMain.controller;
      const timeout = setTimeout(() => {
        calls.push("test-timeout");
        console.error(JSON.stringify({ harnessTimeout: calls }));
        controller.abort();
      }, 3000);
      try {
        await module.runBridge(f.policy.configPath, controller.signal);
        if (calls.includes("test-timeout"))
          throw Error("Main harness timed out");
      } finally {
        clearTimeout(timeout);
        for (const [k, v] of Object.entries(old))
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        delete globalThis.__bootstrapMain;
      }
    },
  };
}
test(
  "real main startup wires same runner and root-bound capability",
  use(async (f) => {
    await f.emit();
    const m = await mainHarness(f);
    await m.run();
    assert.deepEqual(m.calls, [
      "identity",
      "lock",
      "socket-boundary",
      "outbox-boundary",
      "unlock",
    ]);
    assert.equal(
      JSON.parse(await fs.readFile(f.qpath))[0].decisionSlackReceipts.length,
      1,
    );
    assert.deepEqual(f.calls, []);
  }),
);
test(
  "real main bad bootstrap refuses before auth/lock/socket boundary",
  use(async (f) => {
    await fs.appendFile(f.bundle, "changed");
    const m = await mainHarness(f);
    await assert.rejects(m.run());
    assert.deepEqual(m.calls, []);
    assert.deepEqual(f.calls, []);
  }),
);
