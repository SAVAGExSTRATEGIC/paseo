import { constants, openSync, closeSync, fstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  parseDecisionCommand,
  decisionToken,
  type CanonicalDecisionPort,
  type DecisionBinding,
  type DecisionCommit,
  type DecisionReceipt,
  type DecisionView,
} from "./decision-queue.js";
import { authorizeMessage, SlackPolicySchema, type SlackIntake } from "./conversations.js";

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export interface SlackJournalPolicy {
  ownerUid: number;
  journalRoot: string;
  journalPath: string;
  configRoot: string;
  configPath: string;
  configSha256: string;
  appId: string;
  binding: DecisionBinding;
  admissions: {
    originalEventId: string;
    revision: string;
    expectedVersion: number;
    action: DecisionCommit["action"];
  }[];
}
export interface CanonicalQuestion {
  id: string;
  question: string;
  context: string | null;
  options: string[];
  recommended: number | null;
  decisionLoop?: {
    version: number;
    taskId: string;
    origin: { revision: string };
    state: DecisionView["state"];
    events: { id: string; requestDigest?: string; type: string }[];
  };
  decisionSlackReceipts?: (DecisionReceipt & { sourceRevision: string })[];
  [key: string]: unknown;
}
export interface CanonicalSlackTransition {
  id: string;
  questionId: string;
  expectedVersion: number;
  at: string;
  type: DecisionCommit["action"];
  text: string;
  requestDigest: string;
  actor: {
    kind: "human";
    identity: string;
    reference: string;
    source: {
      platform: "slack";
      account: string;
      session: string;
      message: string;
      revision: string;
      item: string;
    };
  };
}
export interface ExistingCanonicalTransactions {
  read(): Promise<CanonicalQuestion[]>;
  mutate<T>(
    fn: (rows: CanonicalQuestion[]) => {
      questions: CanonicalQuestion[];
      result: T;
    },
  ): Promise<T>;
  transition(rows: CanonicalQuestion[], event: CanonicalSlackTransition): CanonicalQuestion[];
}
function boundBytes(file: string, root: string, uid: number) {
  const actualRoot = realpathSync(root),
    actual = path.resolve(file);
  if (realpathSync(actual) !== actual || !actual.startsWith(actualRoot + path.sep))
    throw Error("Unbound/symlink Slack evidence");
  const fd = openSync(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.uid !== uid ||
      before.mode & 0o077 ||
      before.size > 16 * 1024 * 1024
    )
      throw Error("Unsafe Slack evidence owner/mode/size");
    const bytes = readFileSync(fd),
      after = fstatSync(fd);
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      bytes.length !== before.size
    )
      throw Error("Slack evidence changed during read");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function receiverJournal(
  config: { dataDirectory?: unknown },
  policy: Pick<SlackJournalPolicy, "journalRoot" | "journalPath">,
) {
  if (
    typeof config.dataDirectory !== "string" ||
    realpathSync(config.dataDirectory) !== realpathSync(policy.journalRoot) ||
    path.resolve(policy.journalPath) !==
      path.join(realpathSync(policy.journalRoot), "conversations.json")
  )
    throw Error("Slack receiver/journal identity mismatch");
}
// Trust boundary: the existing authenticated Socket Mode receiver's private
// journal plus exact operator-commissioned config/admissions. Not a Slack
// cryptographic attestation or isolation from a malicious same-UID process.
export function readScopedSlackJournalEvent(
  policy: Omit<SlackJournalPolicy, "admissions">,
  originalEventId: string,
) {
  const configBytes = boundBytes(policy.configPath, policy.configRoot, policy.ownerUid);
  if (createHash("sha256").update(configBytes).digest("hex") !== policy.configSha256)
    throw Error("Slack receiver configuration changed");
  const config = JSON.parse(configBytes.toString("utf8")),
    receiver = SlackPolicySchema.parse(config.policy),
    b = policy.binding;
  receiverJournal(config, policy);
  if (
    config.appId !== policy.appId ||
    receiver.teamId !== b.teamId ||
    b.disclosureApproved !== true
  )
    throw Error("Uncommissioned Slack account/disclosure");
  const journal = JSON.parse(
    boundBytes(policy.journalPath, policy.journalRoot, policy.ownerUid).toString("utf8"),
  );
  if (!Array.isArray(journal.intake)) throw Error("Missing original Slack intake");
  const matches = journal.intake.filter(
    (candidate: unknown): candidate is SlackIntake =>
      typeof candidate === "object" &&
      candidate !== null &&
      "id" in candidate &&
      candidate.id === originalEventId,
  );
  if (matches.length !== 1) throw Error("Missing/ambiguous original Slack event");
  const e = matches[0];
  authorizeMessage(receiver, e);
  if (
    !["accepted", "completed", "needs_attention"].includes(e.phase) ||
    typeof e.text !== "string" ||
    !e.text.trim() ||
    typeof e.id !== "string" ||
    !Number.isSafeInteger(e.receivedAt) ||
    e.receivedAt <= 0 ||
    !/^\d+\.\d+$/u.test(e.messageTs) ||
    !/^\d+\.\d+$/u.test(e.rootTs) ||
    [e.teamId, e.userId, e.channelId, e.rootTs, e.isDM].some(
      (v, i) => v !== [b.teamId, b.userId, b.channelId, b.rootTs, b.isDM][i],
    )
  )
    throw Error("Slack original event/audience mismatch");
  const revision = hash({
    id: e.id,
    teamId: e.teamId,
    userId: e.userId,
    channelId: e.channelId,
    rootTs: e.rootTs,
    messageTs: e.messageTs,
    text: e.text,
    isDM: e.isDM,
    receivedAt: e.receivedAt,
  });
  const command = parseDecisionCommand(e.text);
  const eventId = "slack-decision:" + hash([e.teamId, e.id]),
    eventDigest = hash([
      [e.teamId, e.channelId, e.rootTs, e.userId, e.isDM],
      e.id,
      e.messageTs,
      e.text,
    ]);
  return { event: e, revision, command, eventId, eventDigest };
}
export function readAcceptedSlackSource(policy: SlackJournalPolicy, originalEventId: string) {
  const source = readScopedSlackJournalEvent(policy, originalEventId),
    admissions = policy.admissions.filter(
      (a) => a.originalEventId === source.event.id && a.revision === source.revision,
    );
  if (admissions.length !== 1) throw Error("Unadmitted/edited Slack event revision");
  const admission = admissions[0];
  if (
    source.command.action !== admission.action ||
    !Number.isSafeInteger(admission.expectedVersion) ||
    admission.expectedVersion < 1
  )
    throw Error("Slack action/version admission mismatch");
  return { ...source, admission };
}
export function createCanonicalSlackPort(
  input: SlackJournalPolicy,
  canonical: ExistingCanonicalTransactions,
): CanonicalDecisionPort {
  const policy = structuredClone(input),
    b = policy.binding;
  function question(rows: CanonicalQuestion[]) {
    const matches = rows.filter((q) => q.id === b.questionId),
      q = matches[0];
    if (
      matches.length !== 1 ||
      !q.decisionLoop ||
      q.decisionLoop.taskId !== b.taskId ||
      q.decisionLoop.origin.revision !== b.originRevision ||
      q.secret === true ||
      q.isSecret === true
    )
      throw Error("Canonical question/task/origin mismatch");
    return q;
  }
  function sourceFor(eventId: string) {
    const matches = policy.admissions.filter(
      (a) => "slack-decision:" + hash([b.teamId, a.originalEventId]) === eventId,
    );
    if (matches.length !== 1) throw Error("Unadmitted Slack event identity");
    return readAcceptedSlackSource(policy, matches[0].originalEventId);
  }
  function known(q: CanonicalQuestion, s: ReturnType<typeof sourceFor>) {
    const rows = (q.decisionSlackReceipts ?? []).filter((r) => r.eventId === s.eventId);
    if (!rows.length) return null;
    const r = rows[0],
      event = q.decisionLoop!.events.filter((e) => e.id === s.eventId);
    if (
      rows.length !== 1 ||
      r.sourceRevision !== s.revision ||
      r.eventDigest !== s.eventDigest ||
      r.questionId !== b.questionId ||
      r.taskId !== b.taskId ||
      r.originRevision !== b.originRevision ||
      r.version !== s.admission.expectedVersion + 1 ||
      event.length !== 1 ||
      event[0].requestDigest !==
        hash({
          source: s.revision,
          eventDigest: s.eventDigest,
          questionId: b.questionId,
          taskId: b.taskId,
          origin: b.originRevision,
          version: s.admission.expectedVersion,
          action: s.command.action,
          text: s.command.text,
        })
    )
      throw Error("Conflicting canonical Slack receipt");
    const { sourceRevision: _sourceRevision, ...receipt } = r;
    return receipt;
  }
  return {
    async read(id) {
      if (id !== b.questionId) throw Error("Unbound canonical question");
      const bytes = boundBytes(policy.configPath, policy.configRoot, policy.ownerUid);
      if (createHash("sha256").update(bytes).digest("hex") !== policy.configSha256)
        throw Error("Slack receiver configuration changed");
      const config = JSON.parse(bytes.toString("utf8"));
      receiverJournal(config, policy);
      if (config.appId !== policy.appId || b.disclosureApproved !== true)
        throw Error("Uncommissioned Slack disclosure");
      authorizeMessage(SlackPolicySchema.parse(config.policy), {
        ...b,
        id: "policy-disclosure-check",
        text: "",
        messageTs: b.rootTs,
      });
      const q = question(await canonical.read());
      return {
        id: q.id,
        taskId: b.taskId,
        originRevision: b.originRevision,
        version: q.decisionLoop!.version,
        question: q.question,
        context: q.context,
        options: q.options,
        recommended: q.recommended,
        state: q.decisionLoop!.state,
        secret: false,
      };
    },
    async receipt(id) {
      const s = sourceFor(id);
      return known(question(await canonical.read()), s);
    },
    async commit(request) {
      const s = sourceFor(request.eventId),
        q = question(await canonical.read()),
        old = known(q, s);
      const expected = {
        eventId: s.eventId,
        eventDigest: s.eventDigest,
        questionId: b.questionId,
        expectedVersion: s.admission.expectedVersion,
        taskId: b.taskId,
        originRevision: b.originRevision,
        action: s.command.action,
        text: s.command.text,
        source: {
          platform: "slack",
          account: s.event.teamId,
          channel: s.event.channelId,
          rootTs: s.event.rootTs,
          message: s.event.messageTs,
          actor: s.event.userId,
        },
      };
      if (
        hash([
          request.eventId,
          request.eventDigest,
          request.questionId,
          request.expectedVersion,
          request.taskId,
          request.originRevision,
          request.action,
          request.text,
          request.source.platform,
          request.source.account,
          request.source.channel,
          request.source.rootTs,
          request.source.message,
          request.source.actor,
        ]) !==
          hash([
            expected.eventId,
            expected.eventDigest,
            expected.questionId,
            expected.expectedVersion,
            expected.taskId,
            expected.originRevision,
            expected.action,
            expected.text,
            expected.source.platform,
            expected.source.account,
            expected.source.channel,
            expected.source.rootTs,
            expected.source.message,
            expected.source.actor,
          ]) ||
        s.command.token !==
          decisionToken(b, {
            id: q.id,
            taskId: b.taskId,
            originRevision: b.originRevision,
            version: s.admission.expectedVersion,
          } as DecisionView)
      )
        throw Error("Slack commit differs from original source/admission");
      if (old) return old;
      if (s.event.phase !== "accepted")
        throw Error("Original Slack event is not eligible for a new commit");
      const requestDigest = hash({
        source: s.revision,
        eventDigest: s.eventDigest,
        questionId: b.questionId,
        taskId: b.taskId,
        origin: b.originRevision,
        version: s.admission.expectedVersion,
        action: s.command.action,
        text: s.command.text,
      });
      class AlreadyCommitted extends Error {
        constructor(readonly receipt: DecisionReceipt) {
          super("Committed canonical Slack receipt");
        }
      }
      try {
        return await canonical.mutate((rows) => {
          const fresh = sourceFor(request.eventId);
          if (JSON.stringify(fresh) !== JSON.stringify(s))
            throw Error("Slack source changed before locked commit");
          const current = question(rows),
            prior = known(current, fresh);
          if (prior) throw new AlreadyCommitted(prior);
          if (current.decisionLoop!.version !== s.admission.expectedVersion)
            throw Error("Stale canonical Slack version");
          const next = canonical.transition(rows, {
            id: s.eventId,
            questionId: b.questionId,
            expectedVersion: s.admission.expectedVersion,
            at: new Date(s.event.receivedAt).toISOString(),
            type: s.command.action,
            text: s.command.text,
            requestDigest,
            actor: {
              kind: "human",
              identity: s.event.userId,
              source: {
                platform: "slack",
                account: s.event.teamId,
                session: s.event.channelId + "/" + s.event.rootTs,
                message: s.event.messageTs,
                revision: s.revision,
                item: s.event.id,
              },
              reference: `slack:${s.event.teamId}/${s.event.channelId}/${s.event.messageTs}@${s.revision}`,
            },
          });
          const updated = question(next),
            receipt = {
              eventId: s.eventId,
              eventDigest: s.eventDigest,
              questionId: b.questionId,
              taskId: b.taskId,
              originRevision: b.originRevision,
              version: s.admission.expectedVersion + 1,
            };
          if (
            updated.decisionLoop!.version !== receipt.version ||
            !updated.decisionLoop!.events.some(
              (e) => e.id === s.eventId && e.requestDigest === requestDigest,
            )
          )
            throw Error("Canonical reducer result mismatch");
          updated.decisionSlackReceipts = [
            ...(updated.decisionSlackReceipts ?? []),
            { ...receipt, sourceRevision: s.revision },
          ];
          return { questions: next, result: receipt };
        });
      } catch (e) {
        if (e instanceof AlreadyCommitted) return e.receipt;
        throw e;
      }
    },
  };
}
