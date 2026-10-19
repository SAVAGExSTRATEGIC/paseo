import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { BridgeConfig } from "./config.js";
import { authorizeMessage } from "./conversations.js";
import {
  createSlackDecisionComposition,
  type SlackDecisionComposition,
} from "./decision-composition.js";
import type { ExistingCanonicalTransactions } from "./canonical-slack-port.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const abs = z.string().refine(path.isAbsolute);
const manifestSchema = z
  .object({
    version: z.literal(1),
    enabled: z.literal(true),
    release: z.string().regex(/^[a-f0-9]{40}$/u),
    ownerUid: z.number().int().nonnegative(),
    configPath: abs,
    configSha256: hashSchema,
    stageRoot: abs,
    canonicalSourceRoot: abs,
    canonicalHome: abs,
    sources: z
      .object({
        "server/store.ts": hashSchema,
        "server/decision-loop.ts": hashSchema,
        "shared/bots.ts": hashSchema,
      })
      .strict(),
    bundleSha256: hashSchema,
    scope: z
      .object({
        ownerUid: z.number().int().nonnegative(),
        journalRoot: abs,
        journalPath: abs,
        configRoot: abs,
        configPath: abs,
        configSha256: hashSchema,
        appId: z.string().min(1),
        binding: z
          .object({
            teamId: z.string().min(1),
            userId: z.string().min(1),
            channelId: z.string().min(1),
            rootTs: z.string().regex(/^\d+\.\d+$/u),
            isDM: z.boolean(),
            questionId: z.string().min(1),
            taskId: z.string().min(1),
            originRevision: z.string().min(1),
            disclosureApproved: z.literal(true),
          })
          .strict(),
        allowedActions: z
          .array(z.enum(["answer", "discuss", "defer", "skip", "resume"]))
          .min(1),
      })
      .strict(),
  })
  .strict();

function directory(root: string, uid: number, privateRoot = false): string {
  const resolved = path.resolve(root),
    s = statSync(resolved);
  if (
    realpathSync(resolved) !== resolved ||
    !s.isDirectory() ||
    s.uid !== uid ||
    s.mode & (privateRoot ? 0o077 : 0o022)
  )
    throw Error("Unsafe canonical bootstrap root");
  return resolved;
}
function bytes(
  file: string,
  root: string,
  uid: number,
  privateFile = false,
): Buffer {
  const actual = path.resolve(file);
  if (realpathSync(actual) !== actual || !actual.startsWith(root + path.sep))
    throw Error("Unbound canonical bootstrap file");
  const fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const a = fstatSync(fd);
    if (
      !a.isFile() ||
      a.uid !== uid ||
      a.mode & (privateFile ? 0o077 : 0o022) ||
      a.size > 32 * 1024 * 1024
    )
      throw Error("Unsafe canonical bootstrap file");
    const b = readFileSync(fd),
      c = fstatSync(fd);
    if (
      a.dev !== c.dev ||
      a.ino !== c.ino ||
      a.size !== c.size ||
      a.mtimeMs !== c.mtimeMs ||
      b.length !== a.size
    )
      throw Error("Canonical bootstrap changed during read");
    return b;
  } finally {
    closeSync(fd);
  }
}

/** Operator-pinned, local same-service capability. No manifest means zero canonical IO/imports.
 * A manifest/hash is source admission, never proof of a human disclosure/install grant.
 * Owner-private roots are the trust boundary, not a malicious same-UID sandbox.
 */
export async function loadDecisionBootstrap(input: {
  configFile: string;
  config: BridgeConfig;
  release: string;
  environment: NodeJS.ProcessEnv;
}): Promise<SlackDecisionComposition | undefined> {
  const env = input.environment,
    file = env.PASEO_SLACK_DECISION_MANIFEST,
    pin = env.PASEO_SLACK_DECISION_MANIFEST_SHA256;
  if (!file && !pin) return undefined;
  if (!file || !pin || !/^[a-f0-9]{64}$/u.test(pin))
    throw Error("Incomplete pinned decision bootstrap");
  const uid = process.getuid ? process.getuid() : -1;
  if (uid < 0)
    throw Error("Canonical bootstrap requires owner identity");
  const manifestRoot = directory(path.dirname(file), uid, true),
    raw = bytes(file, manifestRoot, uid, true);
  if (sha(raw) !== pin) throw Error("Decision manifest changed");
  const decoded = JSON.parse(raw.toString("utf8"));
  // A pinned explicit disabled marker does not import or access any canonical root.
  if (decoded?.version === 1 && decoded?.enabled === false) return undefined;
  const m = manifestSchema.parse(decoded),
    scope = m.scope,
    b = scope.binding;
  if (
    m.ownerUid !== uid ||
    scope.ownerUid !== uid ||
    m.release !== input.release ||
    m.configPath !== path.resolve(input.configFile) ||
    scope.configPath !== m.configPath ||
    scope.configSha256 !== m.configSha256 ||
    scope.appId !== input.config.appId ||
    scope.journalRoot !== input.config.dataDirectory ||
    scope.journalPath !== path.join(scope.journalRoot, "conversations.json")
  )
    throw Error("Receiver bootstrap identity mismatch");
  const configRoot = directory(scope.configRoot, uid, true);
  if (sha(bytes(m.configPath, configRoot, uid, true)) !== m.configSha256)
    throw Error("Receiver config changed before bootstrap");
  authorizeMessage(input.config.policy, {
    ...b,
    id: "bootstrap",
    messageTs: b.rootTs,
    text: "",
  });
  const stageRoot = directory(m.stageRoot, uid, true),
    sourceRoot = directory(m.canonicalSourceRoot, uid),
    home = directory(m.canonicalHome, uid, true);
  if (
    !env.PASEO_HOME ||
    realpathSync(env.PASEO_HOME) !== home ||
    process.env.PASEO_HOME !== env.PASEO_HOME
  )
    throw Error("Canonical process home mismatch");
  const questionRoot = path.join(home, "savage-bots"),
    bundle = path.join(stageRoot, "canonical.mjs");
  function verify() {
    directory(home, uid, true);
    directory(questionRoot, uid);
    directory(stageRoot, uid, true);
    directory(sourceRoot, uid);
    // Require an existing canonical file; never create an empty fallback queue.
    const q = statSync(path.join(questionRoot, "questions.json"));
    if (
      !q.isFile() ||
      q.uid !== uid ||
      q.mode & 0o022 ||
      realpathSync(path.join(questionRoot, "questions.json")) !==
        path.join(questionRoot, "questions.json")
    )
      throw Error("Unsafe/missing canonical store");
    for (const [name, digest] of Object.entries(m.sources))
      if (sha(bytes(path.join(sourceRoot, name), sourceRoot, uid)) !== digest)
        throw Error("Canonical approved source drift");
    if (sha(bytes(bundle, stageRoot, uid, true)) !== m.bundleSha256)
      throw Error("Canonical staged module drift");
  }
  verify();
  const canonical = await import(
    pathToFileURL(bundle).href + "?sha256=" + m.bundleSha256
  );
  verify();
  if (
    canonical.botsRootDir !== questionRoot ||
    ![
      canonical.readQuestions,
      canonical.mutateQuestions,
      canonical.transitionQuestions,
    ].every((v) => typeof v === "function")
  )
    throw Error("Canonical exports/root mismatch");
  const port: ExistingCanonicalTransactions = {
    async read() {
      verify();
      return canonical.readQuestions();
    },
    async mutate(fn) {
      verify();
      return canonical.mutateQuestions((rows: Parameters<typeof fn>[0]) => {
        verify();
        return fn(rows);
      });
    },
    transition(rows, event) {
      verify();
      return canonical.transitionQuestions(rows, event);
    },
  };
  return createSlackDecisionComposition(scope, port);
}
