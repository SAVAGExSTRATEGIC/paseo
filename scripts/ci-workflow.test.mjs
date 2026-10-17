import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative as relativePath } from "node:path";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);
const dockerWorkflowPath = new URL(".github/workflows/docker.yml", repoRoot);
const nixWorkflowPath = new URL(".github/workflows/nix.yml", repoRoot);
const filtersPath = new URL(".github/ci-paths.yml", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);
const tartWorkflowPath = new URL(".github/workflows/local-tart-ci.yml", repoRoot);

function tartSourceFixture() {
  const repository = { id: 1382441324, full_name: "SAVAGExSTRATEGIC/paseo" };
  const main = "a".repeat(40);
  const head = "b".repeat(40);
  return {
    env: {
      GITHUB_REPOSITORY: repository.full_name,
      GITHUB_REPOSITORY_ID: String(repository.id),
      GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_REF:
        "SAVAGExSTRATEGIC/paseo/.github/workflows/local-tart-ci.yml@refs/heads/main",
      GITHUB_WORKFLOW_SHA: main,
      JOB_WORKFLOW_REF:
        "SAVAGExSTRATEGIC/paseo/.github/workflows/local-tart-ci.yml@refs/heads/main",
      JOB_WORKFLOW_SHA: main,
      SOURCE_CHECK: "file-observation",
      EVENT_PR_HEAD: head,
      GITHUB_SHA: main,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      EXPECTED_PR: "13",
      EXPECTED_HEAD: head,
      GH_TOKEN: "public-test-fixture",
    },
    pull: {
      state: "open",
      draft: false,
      head: { sha: head, repo: { ...repository } },
      base: { sha: main, ref: "main", repo: { ...repository } },
    },
    main: { sha: main },
    httpOk: true,
    requests: [],
  };
}

async function runTartSourceGate(fixture) {
  const source = readFileSync(tartWorkflowPath, "utf8");
  const match = /<<'SOURCE_GATE'\n([\s\S]*?)\n[ \t]*SOURCE_GATE/.exec(source);
  assert.ok(match, "trusted source gate must precede checkout");
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const gate = new AsyncFunction("process", "fetch", "AbortSignal", match[1]);
  await gate(
    { env: fixture.env },
    async (url, options) => {
      fixture.requests.push(url);
      assert.match(url, /^https:\/\/api\.github\.com\/repos\/SAVAGExSTRATEGIC\/paseo\//);
      assert.equal(options.headers.Authorization, "Bearer public-test-fixture");
      assert.ok(options.signal);
      return {
        ok: fixture.httpOk,
        json: async () => {
          if (url.includes("/git/ref/")) return fixture.mergeRef;
          if (url.endsWith("commits/main")) return fixture.main;
          return fixture.pull;
        },
      };
    },
    AbortSignal,
  );
}

test("historical reusable path runs read-only cloud checks with source admission before checkout", () => {
  const source = readFileSync(tartWorkflowPath, "utf8");
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /workflow_call:/);
  assert.doesNotMatch(source, /^ {2}(push|pull_request_target):\s*$/m);
  assert.doesNotMatch(source, /statuses: write|contents: write|report-pr:/);
  assert.doesNotMatch(source, /^ {2}pull_request:\s*$/m);
  assert.match(source, /'macos-26' \|\| 'ubuntu-24\.04'/);
  assert.doesNotMatch(
    source,
    /self-hosted|Paseo Isolated CI|paseo-isolated-|PASEO_PUBLIC_CI_COMMISSIONED/,
  );
  assert.doesNotMatch(
    source.split("  report-pr:")[0],
    /ubuntu-latest|windows-latest|savage-local-actions/,
  );
  assert.match(source, /persist-credentials: false/);
  assert.match(
    source,
    /ref: \$\{\{ inputs\.expected_head \|\| github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
  );
  assert.match(source, /contents: read/);
  assert.match(source, /pull-requests: read/);
  assert.ok(source.indexOf("SOURCE_GATE") < source.indexOf("uses: actions/checkout@"));
});

test("Tart source gate accepts the exact open same-repository PR and trusted current main", async () => {
  const fixture = tartSourceFixture();
  await runTartSourceGate(fixture);
  assert.equal(fixture.requests.length, 2);
});

test("Tart main qualification admits only exact current trusted main without a PR", async () => {
  const fixture = tartSourceFixture();
  fixture.env.EXPECTED_PR = "";
  fixture.env.EXPECTED_HEAD = fixture.main.sha;
  await runTartSourceGate(fixture);
  assert.deepEqual(fixture.requests, [
    "https://api.github.com/repos/SAVAGExSTRATEGIC/paseo/commits/main",
  ]);
});

for (const [name, mutate] of [
  ["non-main source head", (f) => (f.env.EXPECTED_HEAD = "b".repeat(40))],
  ["main moved after dispatch", (f) => (f.main.sha = "c".repeat(40))],
  ["unreadable main", (f) => (f.httpOk = false)],
  ["foreign workflow", (f) => (f.env.JOB_WORKFLOW_REF += "/foreign")],
]) {
  test(`Tart main qualification refuses ${name}`, async () => {
    const fixture = tartSourceFixture();
    fixture.env.EXPECTED_PR = "";
    fixture.env.EXPECTED_HEAD = fixture.main.sha;
    mutate(fixture);
    await assert.rejects(runTartSourceGate(fixture));
  });
}

for (const [name, mutate] of [
  ["foreign repository", (f) => (f.env.GITHUB_REPOSITORY = "foreign/paseo")],
  ["recreated repository ID", (f) => (f.env.GITHUB_REPOSITORY_ID = "1")],
  ["pull request workflow code", (f) => (f.env.JOB_WORKFLOW_REF += "/foreign")],
  ["non-main ref", (f) => (f.env.GITHUB_REF = "refs/heads/feature")],
  ["non-manual event", (f) => (f.env.GITHUB_EVENT_NAME = "pull_request")],
  ["different workflow SHA", (f) => (f.env.JOB_WORKFLOW_SHA = "c".repeat(40))],
  ["invalid PR input", (f) => (f.env.EXPECTED_PR = "13;echo invalid")],
  ["branch instead of SHA", (f) => (f.env.EXPECTED_HEAD = "main")],
  ["changed PR head", (f) => (f.pull.head.sha = "c".repeat(40))],
  ["closed PR", (f) => (f.pull.state = "closed")],
  ["draft PR", (f) => (f.pull.draft = true)],
  ["external fork", (f) => (f.pull.head.repo.full_name = "foreign/paseo")],
  ["foreign head repository ID", (f) => (f.pull.head.repo.id = 1)],
  ["foreign base repository ID", (f) => (f.pull.base.repo.id = 1)],
  ["different base branch", (f) => (f.pull.base.ref = "next")],
  ["base movement", (f) => (f.pull.base.sha = "c".repeat(40))],
  ["main movement", (f) => (f.main.sha = "c".repeat(40))],
  ["unreadable GitHub source", (f) => (f.httpOk = false)],
]) {
  test(`Tart source gate refuses ${name}`, async () => {
    const fixture = tartSourceFixture();
    mutate(fixture);
    await assert.rejects(runTartSourceGate(fixture));
  });
}

const gatedCiJobs = new Map([
  ["format", { name: "format", contract: "format" }],
  ["lint", { name: "lint", contract: "quality" }],
  ["typecheck", { name: "typecheck", contract: "quality" }],
  ["server-tests-ubuntu", { name: "server-tests (ubuntu-latest)", contracts: ["server", "hub"] }],
  ["server-tests-windows", { name: "server-tests (windows-latest)", contracts: ["server", "hub"] }],
  ["server-tests-macos", { name: "server-tests (macos-14, file observation)", contract: "server" }],
  ["desktop-tests-ubuntu", { name: "desktop-tests (ubuntu-latest)", contract: "desktop" }],
  ["desktop-tests-windows", { name: "desktop-tests (windows-latest)", contract: "desktop" }],
  ["app-tests", { name: "app-tests", contract: "app" }],
  ["sdk-tests", { name: "sdk-tests", contract: "sdk" }],
  ["playwright-1", { name: "playwright (shard 1/4)", contract: "browser" }],
  ["playwright-2", { name: "playwright (shard 2/4)", contract: "browser" }],
  ["playwright-3", { name: "playwright (shard 3/4)", contract: "browser" }],
  ["playwright-4", { name: "playwright (shard 4/4)", contract: "browser" }],
  ["relay-tests", { name: "relay-tests", contract: "relay" }],
  ["cli-tests-1", { name: "cli-tests (shard 1/3)", contract: "cli" }],
  ["cli-tests-2", { name: "cli-tests (shard 2/3)", contract: "cli" }],
  ["cli-tests-3", { name: "cli-tests (shard 3/3)", contract: "cli" }],
]);

function jobBlocks(source) {
  const jobs = new Map();
  let currentJob;

  for (const line of source.split("\n")) {
    const jobMatch = /^  ([a-z0-9-]+):\s*$/.exec(line);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs.set(currentJob, []);
      continue;
    }
    if (currentJob) jobs.get(currentJob).push(line);
  }
  return jobs;
}

function loadFilters(path) {
  const filters = {};
  let currentFilter;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const filterMatch = /^([a-z_]+):\s*$/.exec(line);
    if (filterMatch) {
      currentFilter = filterMatch[1];
      filters[currentFilter] = [];
      continue;
    }
    const patternMatch = /^  - "([^"]+)"\s*$/.exec(line);
    if (currentFilter && patternMatch) filters[currentFilter].push(patternMatch[1]);
  }
  return filters;
}

function filesUnder(relativeDirectory, predicate) {
  const directory = new URL(`${relativeDirectory}/`, repoRoot);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      [relativeDirectory, relativePath(directory.pathname, entry.parentPath), entry.name]
        .filter(Boolean)
        .join("/")
        .replaceAll("\\", "/"),
    )
    .filter(predicate)
    .sort();
}

test("gated checks are statically named jobs with real job-level gating", () => {
  const workflowSource = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(workflowSource);
  const trigger = workflowSource.split("jobs:", 1)[0];

  assert.match(trigger, /^\s+merge_group:\s*$/m);
  assert.doesNotMatch(workflowSource, /strategy:\s*\n\s+matrix:/);
  assert.doesNotMatch(workflowSource, /RUN_TESTS|Skip unaffected|No .* changes detected/);

  for (const [jobId, expected] of gatedCiJobs) {
    const job = jobs.get(jobId)?.join("\n");
    assert.ok(job, `missing static job ${jobId}`);
    assert.match(job, new RegExp(`^    name: ${expected.name.replace(/[()]/g, "\\$&")}$`, "m"));
    assert.match(job, /needs\.changes\.outputs\.full != 'false'/);
    for (const contract of expected.contracts ?? [expected.contract]) {
      assert.match(job, new RegExp(`needs\\.changes\\.outputs\\.${contract} != 'false'`));
    }
  }
});

test("change gating allows superseded workflow runs to cancel", () => {
  for (const workflowPath of [ciWorkflowPath, dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    assert.doesNotMatch(
      source,
      /\$\{\{\s*always\(\)/,
      "always() keeps jobs alive after concurrency cancellation; use !cancelled() for fail-open gating",
    );
  }
});

test("focused contracts stay inside existing required checks", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const changes = jobs.get("changes")?.join("\n") ?? "";
  const server = jobs.get("server-tests-ubuntu")?.join("\n") ?? "";
  const desktop = jobs.get("desktop-tests-ubuntu")?.join("\n") ?? "";

  assert.match(changes, /scripts\/daemon-launch-contract\.test\.mjs/);
  assert.doesNotMatch(changes, /Install dependencies|npm run build/);

  assert.match(server, /test:hub-cli-contract/);
  assert.match(server, /npm run test --workspace=@getpaseo\/server/);
  assert.ok(!jobs.has("hub-cli-contract"));

  assert.match(desktop, /test:e2e:renderer/);
  assert.match(desktop, /test:e2e:browser-tabs/);
  assert.match(desktop, /npm run test --workspace=@getpaseo\/desktop/);
  assert.ok(!jobs.has("desktop-browser-bridge"));
  assert.ok(!jobs.has("playwright-desktop"));
});

test("server builds exclude test utilities at every domain depth", () => {
  const tsconfig = JSON.parse(readFileSync(serverTsconfigPath, "utf8"));
  assert.ok(tsconfig.exclude.includes("src/server/**/test-utils/**"));
  assert.ok(!tsconfig.exclude.includes("src/server/test-utils/**"));
});

test("PR routing declares stable behavior ownership", () => {
  const filters = loadFilters(filtersPath);
  assert.deepEqual(filters, {
    routing: [".github/ci-paths.yml"],
    workspace: [
      ".mise.toml",
      ".tool-versions",
      "package.json",
      "package-lock.json",
      "patches/**",
      "scripts/**",
      "tsconfig.json",
      "tsconfig.base.json",
      "vitest.config.ts",
    ],
    ci: [".github/actions/**", ".github/workflows/ci.yml"],
    format: [
      ".agents/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      ".github/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "packages/expo-two-way-audio/**",
    ],
    quality: ["**/*.{cjs,js,json,jsx,mjs,ts,tsx}", "packages/expo-two-way-audio/**"],
    hub: ["packages/cli/src/commands/hub/**", "packages/server/src/server/hub/**"],
    server: ["packages/server/**", "packages/app/e2e/support/fixtures/recording.*"],
    desktop: [
      "packages/desktop/**",
      "packages/app/src/desktop/**",
      "packages/server/src/server/browser-tools/**",
      "packages/app/e2e/support/**",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    app: ["packages/app/**", "packages/expo-two-way-audio/**"],
    sdk: [
      "packages/plugin/**",
      "plugin-examples/**",
      "public-docs/plugins/**",
      "packages/client/**",
      "packages/highlight/**",
      "packages/protocol/**",
    ],
    browser: [
      "packages/server/src/server/agent/provider-snapshot-manager.ts",
      "packages/server/src/server/session/provider/provider-catalog-session.ts",
      "packages/client/src/compat/normalize-provider-models.ts",
      "packages/protocol/src/client-capabilities.ts",
      "packages/server/src/server/agent/provider-registry.ts",
      "packages/server/src/server/agent/agent-sdk-types.ts",
      "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
      "packages/server/src/server/agent/providers/claude/agent.ts",
      "packages/server/src/server/agent/plugin-provider.ts",
      "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
      "packages/server/src/executable-resolution/**",
      "packages/plugin/src/server/provider.ts",
      "packages/app/src/!(desktop)/**",
      "packages/app/e2e/browser/**",
      "packages/app/e2e/support/**",
      "packages/app/assets/**",
      "packages/app/public/**",
      "packages/app/index.ts",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    relay: ["packages/relay/**"],
    cli: ["packages/cli/**"],
  });
});

test("cross-package invariants live in the suite that owns them", () => {
  const cliTests = filesUnder("packages/cli", (path) => path.endsWith(".test.ts"));
  assert.ok(cliTests.length > 0);
  for (const path of cliTests) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /server\/src\/server\/test-utils/,
      path,
    );
  }

  const protocolWireCompatibility = new URL(
    "packages/protocol/src/messages.wire-compat.test.ts",
    repoRoot,
  );
  assert.match(readFileSync(protocolWireCompatibility, "utf8"), /wire schema compatibility/);
});

test("browser and desktop tests have exclusive, directory-owned suites", () => {
  const filters = loadFilters(filtersPath);
  const browserSpecs = filesUnder("packages/app/e2e", (path) => path.endsWith(".spec.ts"));
  const desktopSpecs = filesUnder("packages/desktop/e2e", (path) => path.endsWith(".spec.ts"));
  const electronModules = filesUnder("packages/app/src", (path) => /\.electron\.tsx?$/.test(path));

  assert.ok(browserSpecs.length > 0);
  assert.ok(desktopSpecs.length > 0);
  assert.ok(browserSpecs.every((path) => path.startsWith("packages/app/e2e/browser/")));
  assert.ok(desktopSpecs.every((path) => path.startsWith("packages/desktop/e2e/")));
  assert.ok(electronModules.every((path) => path.startsWith("packages/app/src/desktop/")));

  const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
  assert.match(desktopPackage.scripts.test, /--exclude ["']e2e\/\*\*["']/);

  for (const path of browserSpecs) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /paseoDesktop|injectDesktopBridge/,
    );
  }
  for (const path of desktopSpecs) {
    assert.ok(path.startsWith("packages/desktop/e2e/"));
  }

  const routingSource = readFileSync(filtersPath, "utf8");
  assert.doesNotMatch(routingSource, /desktop_bridge|playwright_desktop|browser-\*|browser-\*\//);
  assert.deepEqual(filters.desktop, [
    "packages/desktop/**",
    "packages/app/src/desktop/**",
    "packages/server/src/server/browser-tools/**",
    "packages/app/e2e/support/**",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
  assert.deepEqual(filters.browser, [
    "packages/server/src/server/agent/provider-snapshot-manager.ts",
    "packages/server/src/server/session/provider/provider-catalog-session.ts",
    "packages/client/src/compat/normalize-provider-models.ts",
    "packages/protocol/src/client-capabilities.ts",
    "packages/server/src/server/agent/provider-registry.ts",
    "packages/server/src/server/agent/agent-sdk-types.ts",
    "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
    "packages/server/src/server/agent/providers/claude/agent.ts",
    "packages/server/src/server/agent/plugin-provider.ts",
    "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
    "packages/server/src/executable-resolution/**",
    "packages/plugin/src/server/provider.ts",
    "packages/app/src/!(desktop)/**",
    "packages/app/e2e/browser/**",
    "packages/app/e2e/support/**",
    "packages/app/assets/**",
    "packages/app/public/**",
    "packages/app/index.ts",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
});

test("packaging preserves main coverage and limits Nix pull requests to dependency inputs", () => {
  for (const workflowPath of [dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    const trigger = source.split("jobs:", 1)[0];
    assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
    if (workflowPath === nixWorkflowPath) {
      assert.match(trigger, /pull_request:\s*\n\s+branches: \[main\]\s*\n\s+paths:/);
      assert.match(trigger, /"package-lock\.json"/);
      assert.match(trigger, /"nix\/\*\*"/);
    } else {
      assert.doesNotMatch(trigger, /pull_request/);
    }
    assert.doesNotMatch(source, /dorny\/paths-filter/);
  }
});

test("desktop packaging smokes main pushes and only the pull requests that touch packaging", () => {
  const source = readFileSync(new URL(".github/workflows/desktop-packages.yml", repoRoot), "utf8");
  const trigger = source.split("jobs:", 1)[0];
  assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
  assert.match(trigger, /pull_request:\s*\n\s+branches: \[main\]\s*\n\s+paths:/);
  assert.match(trigger, /- "packages\/desktop\/\*\*"/);
  assert.doesNotMatch(source, /dorny\/paths-filter/);
  for (const action of ["actions/checkout", "actions/setup-node", "actions/upload-artifact"]) {
    assert.match(source, new RegExp(`${action}@[0-9a-f]{40} # v\\d+\\.\\d+\\.\\d+`));
  }
});

for (const event of ["push", "pull_request_target"]) {
  test(`Tart automatic ${event} validates immutable source`, async () => {
    const fixture = tartSourceFixture();
    fixture.env.GITHUB_EVENT_NAME = event;
    if (event === "push") {
      fixture.env.EXPECTED_PR = "";
      fixture.env.EXPECTED_HEAD = fixture.main.sha;
    }
    await runTartSourceGate(fixture);
  });
}

test("Tart pull request target cannot silently check main", async () => {
  const fixture = tartSourceFixture();
  fixture.env.GITHUB_EVENT_NAME = "pull_request_target";
  fixture.env.EXPECTED_PR = "";
  fixture.env.EXPECTED_HEAD = fixture.main.sha;
  await assert.rejects(runTartSourceGate(fixture));
});

function reusablePRFixture() {
  const f = tartSourceFixture();
  f.env.GITHUB_EVENT_NAME = "pull_request";
  f.env.GITHUB_REF = "refs/pull/13/merge";
  f.env.GITHUB_WORKFLOW_REF = "SAVAGExSTRATEGIC/paseo/.github/workflows/ci.yml@refs/pull/13/merge";
  f.env.EXPECTED_HEAD = f.env.GITHUB_SHA = f.pull.merge_commit_sha = "c".repeat(40);
  f.env.SOURCE_CHECK = "typecheck";
  return f;
}

test("reusable Tart check binds trusted job definition and exact PR merge candidate", async () => {
  await runTartSourceGate(reusablePRFixture());
});

for (const [name, mutate] of [
  ["caller substitutes another commit", (f) => (f.env.EXPECTED_HEAD = "d".repeat(40))],
  ["PR head moved", (f) => (f.pull.head.sha = "d".repeat(40))],
  ["merge candidate changed", (f) => (f.pull.merge_commit_sha = "d".repeat(40))],
  ["PR-controlled job definition", (f) => (f.env.JOB_WORKFLOW_REF = f.env.GITHUB_WORKFLOW_REF)],
  ["arbitrary check command", (f) => (f.env.SOURCE_CHECK = "typecheck; echo bypass")],
]) {
  test(`reusable Tart check refuses ${name}`, async () => {
    const f = reusablePRFixture();
    mutate(f);
    await assert.rejects(runTartSourceGate(f));
  });
}

test("merge queue checks bind current base and still-existing exact queue ref", async () => {
  const f = tartSourceFixture();
  f.env.GITHUB_EVENT_NAME = "merge_group";
  f.env.EXPECTED_PR = "";
  f.env.GITHUB_REF = "refs/heads/gh-readonly-queue/main/pr-13-fixture";
  f.env.EXPECTED_HEAD = f.env.GITHUB_SHA = f.env.EVENT_MERGE_HEAD = "c".repeat(40);
  f.env.EVENT_MERGE_BASE = f.main.sha;
  f.mergeRef = { object: { sha: f.env.EXPECTED_HEAD } };
  await runTartSourceGate(f);
  f.mergeRef.object.sha = "d".repeat(40);
  await assert.rejects(runTartSourceGate(f));
});

test("fixed Linux check commands retain each existing check without paid API secrets", () => {
  const script = readFileSync(new URL("scripts/local-tart-check.sh", repoRoot), "utf8");
  for (const name of gatedCiJobs.keys()) {
    if (name.endsWith("-windows") || name === "server-tests-macos") continue;
    assert.ok(script.includes(`  ${name})`), `${name} must be implemented`);
  }
  assert.doesNotMatch(script, /OPENAI_API_KEY|OPENROUTER_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|\beval\b/);
  assert.match(script, /npm run test --workspace=@getpaseo\/server/);
  assert.match(script, /npm run typecheck/);
  assert.match(script, /npm audit signatures/);
  assert.match(script, /xvfb-run/);
  assert.match(script, /test:e2e:browser-tabs/);
});

test("Nix hash validation cannot write main or require publishing credentials", () => {
  const source = readFileSync(new URL(".github/workflows/nix-update-hash.yml", repoRoot), "utf8");
  assert.match(source, /contents: read/);
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /update-nix\.sh --check/);
  assert.match(source, /git diff --exit-code -- package-lock\.json nix\/npm-deps\.hash/);
  assert.doesNotMatch(source, /secrets\.|create-github-app-token|git push|contents: write/);
});

for (const check of ["nix-linux", "nix-hash", "nix-macos", "docker-build"]) {
  test(`packaging source gate admits fixed ${check} command`, async () => {
    const fixture = tartSourceFixture();
    fixture.env.SOURCE_CHECK = check;
    await runTartSourceGate(fixture);
  });
}

test("packaging jobs preserve native Mac coverage and cannot publish or upload build records", () => {
  const source = readFileSync(tartWorkflowPath, "utf8");
  assert.match(source, /inputs.check == 'nix-macos'\) && 'macos-26'/);
  assert.match(source, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(source, /DOCKER_BUILD_RECORD_UPLOAD: "false"/);
  assert.match(source, /push: false/);
  assert.doesNotMatch(
    source,
    /packages: write|cache-to:|cache-from:|uses: actions\/upload-artifact/,
  );
  const script = readFileSync(new URL("scripts/local-tart-check.sh", repoRoot), "utf8");
  assert.match(script, /nix-macos\)[\s\S]*CFBundleIdentifier/);
  assert.match(script, /nix-linux\)[\s\S]*connectedDaemon/);
  assert.match(script, /nix-hash\)[\s\S]*git diff --exit-code/);
});

function browserStorageStep() {
  const source = readFileSync(tartWorkflowPath, "utf8").replace(/\r\n/g, "\n");
  const match =
    /      - name: Use job-local Playwright browser storage\n        shell: bash\n        run: \|\n((?:          .*\n)+)/.exec(
      source,
    );
  assert.ok(match, "Tart browser installs need writable job-local storage");
  assert.ok(source.indexOf(match[0]) < source.indexOf("      - name: Install dependencies"));
  return match[1].replace(/^          /gm, "");
}

test("Tart browser storage is configured before dependency installation", () => {
  browserStorageStep();
});

test(
  "Tart guest browser installs use writable job storage without changing the image cache",
  {
    skip: process.platform === "win32" ? "Tart guests run Linux or macOS" : false,
  },
  (t) => {
    const root = mkdtempSync(join(tmpdir(), "tart browser storage "));
    const imageCache = join(root, "image browsers");
    mkdirSync(imageCache, { mode: 0o555 });
    const jobTemp = join(root, "job temp");
    mkdirSync(jobTemp);
    const githubEnv = join(root, "github env");
    writeFileSync(githubEnv, "");
    t.after(() => {
      chmodSync(imageCache, 0o700);
      rmSync(root, { recursive: true, force: true });
    });
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", browserStorageStep()], {
      env: {
        ...process.env,
        RUNNER_TEMP: jobTemp,
        GITHUB_ENV: githubEnv,
        PLAYWRIGHT_BROWSERS_PATH: imageCache,
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const cache = join(jobTemp, "playwright-browsers");
    assert.equal(readFileSync(githubEnv, "utf8"), `PLAYWRIGHT_BROWSERS_PATH=${cache}\n`);
    writeFileSync(join(cache, "__dirlock"), "writable browser installation");
    assert.deepEqual(readdirSync(imageCache), []);
    assert.equal(statSync(imageCache).mode & 0o777, 0o555);
  },
);

test(
  "Electron guest preflight blocks missing libraries before desktop launch",
  { skip: process.platform === "win32" ? "The guest preflight runs on Linux" : false },
  () => {
    const source = readFileSync(new URL("scripts/local-tart-check.sh", repoRoot), "utf8");
    const match = /Check Electron shared libraries\\n'\n([\s\S]*?)    printf '::endgroup::/.exec(
      source,
    );
    assert.ok(match, "The Linux desktop check must inspect its actual Electron runtime");
    const root = mkdtempSync(join(tmpdir(), "paseo electron preflight "));
    try {
      const bin = join(root, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "node"), "#!/bin/bash\nprintf '/fixture/electron\\n'\n", {
        mode: 0o755,
      });
      writeFileSync(join(bin, "ldd"), '#!/bin/bash\nprintf "%s\\n" "$LOADER_REPORT"\n', {
        mode: 0o755,
      });
      for (const [report, expected] of [
        ["libgtk-3.so.0 => /lib/libgtk-3.so.0", 0],
        ["libgtk-3.so.0 => not found", 1],
      ]) {
        const result = spawnSync(
          "/bin/bash",
          ["-c", `set -euo pipefail\n${match[1]}\nprintf 'LAUNCH_ALLOWED\\n'`],
          {
            encoding: "utf8",
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOADER_REPORT: report },
          },
        );
        assert.equal(result.status, expected, result.stderr);
        assert.equal(result.stdout.includes("LAUNCH_ALLOWED"), expected === 0);
        if (expected !== 0) assert.match(result.stderr, /runtime libraries are missing/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("Tart desktop retains the original thirty-minute job bound", () => {
  const workflow = readFileSync(tartWorkflowPath, "utf8");
  assert.match(
    workflow,
    /timeout-minutes: \$\{\{ inputs\.check == 'desktop-tests-ubuntu' && 30 \|\| 90 \}\}/,
  );
});

test("Electron cleanup handles a past crash and waits for a live child", async () => {
  const { waitForChildExit } = await import("../packages/desktop/e2e/child-exit.mjs");
  const { EventEmitter } = await import("node:events");
  for (const outcome of [
    { exitCode: 1, signalCode: null },
    { exitCode: null, signalCode: "SIGILL" },
  ]) {
    const child = Object.assign(new EventEmitter(), outcome);
    await waitForChildExit(child);
    assert.equal(child.listenerCount("exit"), 0);
  }
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  let done = false;
  const waiting = waitForChildExit(child).then(() => {
    done = true;
    return undefined;
  });
  await Promise.resolve();
  assert.equal(done, false);
  child.emit("exit", 0, null);
  await waiting;
  assert.equal(done, true);
});
