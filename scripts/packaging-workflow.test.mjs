import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (name) =>
  readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");

// These filters deliberately use only *, ** and literal paths. Evaluate their
// ordered include/exclude behavior against runtime and non-runtime changes.
function pushPaths(name) {
  const push = source(name).match(/^  push:\n([\s\S]*?)(?=^  \w|^\S)/m)?.[1];
  assert.ok(push, `${name}: main push remains enabled`);
  const paths = push.match(/^    paths:\n((?:      - .*\n)+)/m)?.[1];
  assert.ok(paths, `${name}: filter main pushes before allocating runners`);
  return [...paths.matchAll(/^      - (".*")$/gm)].map((m) => JSON.parse(m[1]));
}

function selected(patterns, filename) {
  let included = false;
  for (const pattern of patterns) {
    const negative = pattern.startsWith("!");
    const glob = negative ? pattern.slice(1) : pattern;
    const expression = glob
      .split("**")
      .map((part) =>
        part
          .split("*")
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/]*"),
      )
      .join(".*");
    if (new RegExp(`^${expression}$`).test(filename)) included = !negative;
  }
  return included;
}

for (const name of ["docker", "nix", "desktop-packages"]) {
  test(`${name}: prose and unrelated CI changes do not allocate packaging runners`, () => {
    const paths = pushPaths(name);
    for (const file of [
      "README.md",
      "AGENTS.md",
      "docs/testing.md",
      "public-docs/plugins/install.md",
      ".github/workflows/ci.yml",
      ".github/ci-paths.yml",
      ".agents/skills/review/SKILL.md",
    ]) {
      assert.equal(selected(paths, file), false, file);
    }
  });
  test(`${name}: runtime assets, dependencies, build tools and unknown inputs remain covered`, () => {
    const paths = pushPaths(name);
    for (const file of [
      "package.json",
      "package-lock.json",
      ".npmrc",
      "tsconfig.json",
      "packages/protocol/src/messages.ts",
      "packages/server/src/server/session.ts",
      "packages/app/assets/icon.png",
      "packages/app/metro.config.js",
      "packages/desktop/scripts/after-pack.js",
      "packages/client/src/index.ts",
      "skills/review/SKILL.md",
      "plugins/example/README.md",
      "patches/dependency.patch",
      "scripts/trace-daemon.mjs",
      "new-build-input.bin",
      `.github/workflows/${name}.yml`,
    ]) {
      assert.equal(selected(paths, file), true, file);
    }
    assert.match(source(name), /^  workflow_dispatch:/m);
  });
}

test("Nix default build has one automatic owner and hash validation remains read-only", () => {
  const hash = source("nix-update-hash");
  assert.doesNotMatch(hash, /run: nix build/);
  assert.match(hash, /update-nix\.sh --check/);
  assert.match(hash, /git diff --exit-code -- package-lock\.json nix\/npm-deps\.hash/);
  assert.match(source("nix"), /run: nix build \.#default -o result/);
  assert.match(source("nix"), /connectedDaemon/);
  assert.match(source("nix"), /CFBundleIdentifier/);
  assert.equal(selected(pushPaths("nix"), ".github/workflows/nix-update-hash.yml"), true);
  assert.equal(
    selected(pushPaths("nix-update-hash"), "packages/server/src/server/session.ts"),
    false,
  );
});

test("Docker release tags retain publication and ordinary builds remain non-publishing", () => {
  const docker = source("docker");
  assert.match(docker, /tags:\n      - "v\*"/);
  assert.match(docker, /if: needs.setup.outputs.publish != 'true'/);
  assert.match(docker, /push: false/);
  assert.match(docker, /cancel-in-progress: false/);
});
