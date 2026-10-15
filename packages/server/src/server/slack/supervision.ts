import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { isLocked } from "../pid-lock.js";
import { readBridgeConfig } from "./config.js";
import { SlackStateError } from "./conversations.js";
import { privateDirectory } from "./operations.js";

export const BRIDGE_SERVICE_LABEL = "io.savage.paseo-slack";
const PathSchema = z
  .string()
  .refine(
    (value) =>
      isAbsolute(value) && !["\r", "\n", "\0"].some((character) => value.includes(character)),
  );
const InputSchema = z.object({
  releaseDirectory: PathSchema,
  configFile: PathSchema,
  serviceDirectory: PathSchema,
  nodePath: PathSchema,
  dopplerPath: PathSchema,
  release: z.string().regex(/^[a-f0-9]{40}$/u),
  passwordEnvs: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/u)).min(1),
});
type SupervisionInput = z.infer<typeof InputSchema>;
function shell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderSupervision(input: SupervisionInput) {
  const config = InputSchema.parse(input);
  const launcher = join(config.serviceDirectory, "launch-bridge.sh");
  const entry = join(config.releaseDirectory, "packages/server/dist/server/server/slack/main.js");
  const keys = [
    ...new Set(["PASEO_SLACK_BOT_TOKEN", "PASEO_SLACK_APP_TOKEN", ...config.passwordEnvs]),
  ].join(",");
  const environmentPath = `${dirname(config.nodePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  const script = `#!/bin/sh\nset -eu\numask 077\nexec /usr/bin/env -i HOME="\${HOME:?HOME is required}" PATH=${shell(environmentPath)} PASEO_SLACK_RELEASE=${shell(config.release)} ${shell(config.dopplerPath)} run --no-check-version --project savage --config dev --no-fallback --only-secrets ${shell(keys)} -- ${shell(config.nodePath)} ${shell(entry)} ${shell(config.configFile)}\n`;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${BRIDGE_SERVICE_LABEL}</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(launcher)}</string></array>
<key>WorkingDirectory</key><string>${xml(config.releaseDirectory)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>45</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`;
  return { script, plist, launcher };
}

/** Preparation writes reviewable files only; it never bootstraps or restarts a service. */
export async function prepareSupervision(
  releaseDirectory: string,
  configFile: string,
  serviceDirectory: string,
  dopplerPath: string,
) {
  const config = await readBridgeConfig(configFile);
  if ((await isLocked(config.dataDirectory)).locked)
    throw new SlackStateError("Stop the bridge before changing its launcher");
  const execute = promisify(execFile);
  const release = (
    await execute("git", ["rev-parse", "HEAD"], { cwd: releaseDirectory })
  ).stdout.trim();
  if ((await execute("git", ["status", "--porcelain"], { cwd: releaseDirectory })).stdout.trim())
    throw new SlackStateError("Build a clean committed release before preparing supervision");
  await access(join(releaseDirectory, "packages/server/dist/server/server/slack/main.js"));
  await access(dopplerPath);
  const rendered = renderSupervision({
    releaseDirectory,
    configFile,
    serviceDirectory,
    nodePath: process.execPath,
    dopplerPath,
    release,
    passwordEnvs: config.hosts.map((host) => host.passwordEnv),
  });
  await privateDirectory(serviceDirectory);
  const plistFile = join(serviceDirectory, `${BRIDGE_SERVICE_LABEL}.plist`);
  for (const [file, text, mode] of [
    [rendered.launcher, rendered.script, 0o700],
    [plistFile, rendered.plist, 0o600],
  ] as const) {
    try {
      if ((await readFile(file, "utf8")) !== text)
        throw new SlackStateError(
          "Refusing to replace existing launch files; stage the reviewed update explicitly",
        );
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      await writeFile(file, text, { mode, flag: "wx" });
    }
  }
  return {
    release,
    label: BRIDGE_SERVICE_LABEL,
    launcher: rendered.launcher,
    plistFile,
    installed: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [releaseDirectory, configFile, serviceDirectory, dopplerPath] = process.argv.slice(2);
  if (!releaseDirectory || !configFile || !serviceDirectory || !dopplerPath) {
    process.stderr.write(
      "Use: supervision.js <release-directory> <config-file> <service-directory> <doppler-path>\n",
    );
    process.exitCode = 1;
  } else
    prepareSupervision(releaseDirectory, configFile, serviceDirectory, dopplerPath)
      .then((result) => {
        process.stdout.write(JSON.stringify(result) + "\n");
        return undefined;
      })
      .catch(() => {
        process.stderr.write("supervision_preparation_failed\n");
        process.exitCode = 1;
      });
}
