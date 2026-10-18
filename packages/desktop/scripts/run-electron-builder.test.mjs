import assert from "node:assert/strict";
import test from "node:test";
import { builderEnvironment, runBuilder } from "./run-electron-builder.mjs";

test("missing optional signing secret permits private unsigned packaging", () => {
  for (const certificate of [undefined, "", "  "]) {
    const source = {
      SHOULD_PUBLISH: "false",
      CSC_LINK: certificate,
      CSC_KEY_PASSWORD: "",
      OTHER: "kept",
    };
    const env = builderEnvironment(source, "darwin");
    assert.equal("CSC_LINK" in env, false);
    assert.equal("CSC_KEY_PASSWORD" in env, false);
    assert.equal(env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
    assert.equal(env.OTHER, "kept");
    assert.equal(source.CSC_LINK, certificate);
  }
});
test("publishing without a certificate fails before spawning", () => {
  for (const certificate of [undefined, "", "  "]) {
    assert.throws(
      () =>
        runBuilder([], {
          env: { SHOULD_PUBLISH: "true", CSC_LINK: certificate },
          platform: "darwin",
          spawn: () => assert.fail("spawned unsigned publishing build"),
        }),
      /requires its signing certificate/,
    );
  }
});
test("valid signing configuration and other platforms keep original semantics", () => {
  const source = {
    SHOULD_PUBLISH: "true",
    CSC_LINK: "fixture certificate only",
    CSC_KEY_PASSWORD: "fixture only",
    APPLE_ID: "fixture",
  };
  assert.deepEqual(builderEnvironment(source, "darwin"), source);
  assert.deepEqual(builderEnvironment({ CSC_LINK: "" }, "linux"), { CSC_LINK: "" });
  assert.deepEqual(builderEnvironment({ CSC_LINK: "" }, "darwin"), { CSC_LINK: "" });
});
test("arguments remain separate, no shell, and builder failure propagates", () => {
  const args = ["--config", "path with spaces.yml", "--publish", "never", "--mac", "--arm64"];
  const status = runBuilder(args, {
    env: { SHOULD_PUBLISH: "false", CSC_LINK: "" },
    platform: "darwin",
    cli: "/fixture/builder.js",
    spawn: (exe, forwarded, opts) => {
      assert.equal(exe, process.execPath);
      assert.deepEqual(forwarded, ["/fixture/builder.js", ...args]);
      assert.equal(opts.shell, undefined);
      assert.equal(opts.cwd, undefined);
      assert.equal("CSC_LINK" in opts.env, false);
      return { status: 19 };
    },
  });
  assert.equal(status, 19);
});
test("signal and startup failures cannot be reported successful", () => {
  assert.equal(
    runBuilder([], {
      cli: "/fixture/builder.js",
      spawn: () => ({ status: null, signal: "SIGTERM" }),
    }),
    1,
  );
  assert.throws(
    () =>
      runBuilder([], {
        cli: "/fixture/builder.js",
        spawn: () => ({ error: new Error("fixture unavailable") }),
      }),
    /fixture unavailable/,
  );
});
