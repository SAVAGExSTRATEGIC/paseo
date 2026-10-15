import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import { createBrowserHostInstallPlan } from "./install-plan.js";

test("prepares an exact Chrome native host manifest for the paired origin", () => {
  const home = mkdtempSync(path.join(tmpdir(), "paseo-browser-install-"));
  try {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
    writeFileSync(
      path.join(home, "browser-passport.json"),
      JSON.stringify({
        version: 1,
        host: hostname(),
        chromePath: "/Applications/Google Chrome.app",
        profileDirectory: "Profile 3",
        extensionOrigin,
        publicKeySpkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      }),
    );
    const plan = createBrowserHostInstallPlan({
      paseoHome: home,
      appHostPath: "/Applications/Paseo.app/Contents/Resources/bin/paseo-browser-host",
      userHome: "/Users/test",
    });
    expect(JSON.parse(plan.manifestContent)).toEqual({
      name: "io.paseo.browser_passport",
      description: "Paseo paired Chrome browser host",
      path: plan.wrapperPath,
      type: "stdio",
      allowed_origins: [extensionOrigin],
    });
    expect(plan.wrapperContent).toContain(`PASEO_HOME='${home}'`);
    expect(plan.manifestPath).toContain("Google/Chrome/NativeMessagingHosts");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
