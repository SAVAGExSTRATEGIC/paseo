import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { renderSupervision } from "./supervision.js";

it.skipIf(process.platform === "win32")(
  "runs the rendered launcher with literal paths and only the intended inherited environment",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "slack launcher ' "));
    try {
      const marker = join(directory, "must-not-exist");
      // A local executable adapter inspects launcher arguments; no Doppler or Slack request occurs.
      const adapter = join(directory, "doppler-adapter.mjs");
      await writeFile(
        adapter,
        `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), environment: Object.keys(process.env).sort() }));\n`,
        { mode: 0o700 },
      );
      const configFile = join(directory, `config'; touch ${marker}; '.json`);
      const rendered = renderSupervision({
        releaseDirectory: join(directory, "release & bridge"),
        configFile,
        serviceDirectory: directory,
        nodePath: process.execPath,
        dopplerPath: adapter,
        release: "a".repeat(40),
        passwordEnvs: ["PASEO_SLACK_DAEMON_PASSWORD"],
      });
      await writeFile(rendered.launcher, rendered.script, { mode: 0o700 });
      const result = await promisify(execFile)("/bin/sh", [rendered.launcher], {
        env: { ...process.env, SECRET_MUST_NOT_INHERIT: "private" },
      });
      const captured = JSON.parse(result.stdout);
      expect(
        captured.environment.filter((key: string) => key !== "__CF_USER_TEXT_ENCODING"),
      ).toEqual(["HOME", "PASEO_SLACK_RELEASE", "PATH"]);
      expect(captured.environment).not.toContain("SECRET_MUST_NOT_INHERIT");
      expect(captured.args.at(-1)).toBe(configFile);
      expect(captured.args).toContain("--no-fallback");
      expect(captured.args).toContain(
        "PASEO_SLACK_BOT_TOKEN,PASEO_SLACK_APP_TOKEN,PASEO_SLACK_DAEMON_PASSWORD",
      );
      expect(rendered.plist).toContain("release &amp; bridge");
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("rejects relative paths and line-breaking launch configuration", () => {
  const input = {
    releaseDirectory: "/release",
    configFile: "/config",
    serviceDirectory: "/service",
    nodePath: "/node",
    dopplerPath: "/doppler",
    release: "a".repeat(40),
    passwordEnvs: ["PASEO_SLACK_DAEMON_PASSWORD"],
  };
  expect(() => renderSupervision({ ...input, nodePath: "node" })).toThrow();
  expect(() => renderSupervision({ ...input, configFile: "/config\nextra" })).toThrow();
  expect(() => renderSupervision({ ...input, release: "uncommitted" })).toThrow();
});
