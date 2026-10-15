import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

import { z } from "zod";

import { BrowserToolsBroker } from "../broker.js";
import { BrowserPassportVerifier, type BrowserPassportBinding } from "./verifier.js";

const BrowserPassportBindingFileSchema = z.object({
  version: z.literal(1),
  host: z.string().min(1),
  chromePath: z.string().min(1),
  profileDirectory: z.string().min(1),
  extensionOrigin: z.string().regex(/^chrome-extension:\/\/[a-p]{32}\/$/),
  publicKeySpkiBase64: z.string().min(1),
});

export type BrowserPassportStartup =
  | { required: false; state: "unrestricted" }
  | { required: true; state: "awaiting_pairing" }
  | { required: true; state: "paired"; verifier: BrowserPassportVerifier };

/**
 * A required but unavailable passport never falls through to generic browser hosts.
 * The file holds a public key only; the private signing key stays in Chrome's profile.
 */
export function loadBrowserPassportAtStartup(options: {
  paseoHome: string;
  required: boolean;
  expectedHost?: string;
  expectedChromePath?: string;
  expectedProfileDirectory?: string;
}): BrowserPassportStartup {
  if (!options.required) return { required: false, state: "unrestricted" };

  let parsed: BrowserPassportBinding;
  try {
    const filePath = path.join(options.paseoHome, "browser-passport.json");
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    const binding = BrowserPassportBindingFileSchema.parse(raw);
    if (
      binding.host !== (options.expectedHost ?? hostname()) ||
      binding.chromePath !== (options.expectedChromePath ?? "/Applications/Google Chrome.app") ||
      binding.profileDirectory !== (options.expectedProfileDirectory ?? "Profile 3")
    ) {
      return { required: true, state: "awaiting_pairing" };
    }
    parsed = binding;
  } catch {
    return { required: true, state: "awaiting_pairing" };
  }

  try {
    return {
      required: true,
      state: "paired",
      verifier: new BrowserPassportVerifier({ binding: parsed }),
    };
  } catch {
    return { required: true, state: "awaiting_pairing" };
  }
}

export function createBrowserToolsBrokerAtStartup(options: {
  paseoHome: string;
  required?: boolean;
  env?: NodeJS.ProcessEnv;
  onAwaitingPairing?: () => void;
}): BrowserToolsBroker {
  const required =
    options.required ?? (options.env ?? process.env).PASEO_BROWSER_PASSPORT_REQUIRED === "1";
  const passport = loadBrowserPassportAtStartup({ paseoHome: options.paseoHome, required });
  if (passport.state === "paired") {
    return new BrowserToolsBroker({ passportVerifier: passport.verifier });
  }
  if (passport.required) {
    options.onAwaitingPairing?.();
    return new BrowserToolsBroker({ admitHost: () => false });
  }
  return new BrowserToolsBroker({});
}
