import path from "node:path";

import { readBrowserPassportBindingAtStartup } from "@getpaseo/server/browser-passport";

const HOST_NAME = "io.paseo.browser_passport";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Produces the two public, reviewable files needed for a per-user Chrome host installation. */
export function createBrowserHostInstallPlan(options: {
  paseoHome: string;
  appHostPath: string;
  userHome: string;
}): {
  wrapperPath: string;
  wrapperContent: string;
  manifestPath: string;
  manifestContent: string;
} {
  const binding = readBrowserPassportBindingAtStartup({ paseoHome: options.paseoHome });
  if (!binding) throw new Error("A verified browser passport pairing is required");
  if (!path.isAbsolute(options.appHostPath) || !path.isAbsolute(options.paseoHome)) {
    throw new Error("Browser host paths must be absolute");
  }
  const wrapperPath = path.join(options.paseoHome, "browser-passport-host");
  const manifestPath = path.join(
    options.userHome,
    "Library/Application Support/Google/Chrome/NativeMessagingHosts",
    `${HOST_NAME}.json`,
  );
  return {
    wrapperPath,
    wrapperContent: `#!/bin/sh\nset -eu\nexec env PASEO_HOME=${shellQuote(options.paseoHome)} ${shellQuote(options.appHostPath)} "$@"\n`,
    manifestPath,
    manifestContent: `${JSON.stringify(
      {
        name: HOST_NAME,
        description: "Paseo paired Chrome browser host",
        path: wrapperPath,
        type: "stdio",
        allowed_origins: [binding.extensionOrigin],
      },
      null,
      2,
    )}\n`,
  };
}
