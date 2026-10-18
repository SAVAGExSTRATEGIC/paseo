import fs from "node:fs";
import path from "node:path";

// Keep E2E-owned tools on PATH when Electron resolves its login environment.
// Hosted images may overwrite PATH in /etc/profile; no host profile is edited.
export function createIsolatedLoginShell(directory) {
  const shell = path.join(directory, "bash");
  fs.writeFileSync(shell, '#!/bin/sh\nexec /bin/bash --noprofile --norc "$@"\n', {
    mode: 0o700,
  });
  return shell;
}
