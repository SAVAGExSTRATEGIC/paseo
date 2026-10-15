#!/usr/bin/env node

import { runNativeBrowserHost } from "./native-host.js";

const home = process.env.PASEO_HOME;
const callerOrigin = process.argv[2];
if (!home || !callerOrigin) {
  process.stderr.write("Browser passport host is missing its configured home or Chrome origin.\n");
  process.exitCode = 1;
} else {
  void runNativeBrowserHost({
    home,
    callerOrigin,
    input: process.stdin,
    output: process.stdout,
  }).catch(() => {
    process.stderr.write("Browser passport host could not establish a verified connection.\n");
    process.exitCode = 1;
  });
}
