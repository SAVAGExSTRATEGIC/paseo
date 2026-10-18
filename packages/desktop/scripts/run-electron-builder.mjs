import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function builderEnvironment(environment, platform = process.platform) {
  const env = { ...environment };
  if (platform !== "darwin") return env;
  const certificate = env.CSC_LINK?.trim();
  if (env.SHOULD_PUBLISH === "true" && !certificate) {
    throw new Error("Publishing a macOS release requires its signing certificate");
  }
  // GitHub supplies an empty string for an absent optional secret. Builder treats
  // that string as a certificate path pointing at cwd, rather than no certificate.
  if (env.SHOULD_PUBLISH === "false" && !certificate) {
    delete env.CSC_LINK;
    delete env.CSC_KEY_PASSWORD;
    env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  }
  return env;
}

export function runBuilder(args, options = {}) {
  const env = builderEnvironment(options.env ?? process.env, options.platform);
  const cli =
    options.cli ?? createRequire(import.meta.url).resolve("electron-builder/out/cli/cli.js");
  const result = (options.spawn ?? spawnSync)(process.execPath, [cli, ...args], {
    stdio: "inherit",
    env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runBuilder(process.argv.slice(2));
  } catch {
    // Never print a spawned process/error object that might contain signing env.
    console.error("Desktop packaging could not start with the required signing configuration.");
    process.exitCode = 1;
  }
}
