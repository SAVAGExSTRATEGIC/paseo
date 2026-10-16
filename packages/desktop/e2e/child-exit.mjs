import { once } from "node:events";

// An Electron crash may be observed before the test enters its finally block.
// Subscribe only while the child is live; a past exit will never fire again.
export function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return once(child, "exit");
}
