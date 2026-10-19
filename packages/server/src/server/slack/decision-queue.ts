import { createHash } from "node:crypto";
import {
  SlackPolicyError,
  SlackStateError,
  type SlackIntake,
  type SlackPolicy,
} from "./conversations.js";

export type DecisionAction = "answer" | "discuss" | "defer" | "skip" | "resume";
export interface DecisionView {
  id: string;
  taskId: string;
  originRevision: string;
  version: number;
  question: string;
  context: string | null;
  options: string[];
  recommended: number | null;
  state: "open" | "answered" | "legacy-answered" | "deferred" | "skipped" | "settled";
  secret: boolean;
}
export interface DecisionReceipt {
  eventId: string;
  eventDigest: string;
  questionId: string;
  taskId: string;
  originRevision: string;
  version: number;
}
export interface DecisionCommit {
  eventId: string;
  eventDigest: string;
  questionId: string;
  expectedVersion: number;
  taskId: string;
  originRevision: string;
  action: DecisionAction;
  text: string;
  source: {
    platform: "slack";
    account: string;
    channel: string;
    rootTs: string;
    message: string;
    actor: string;
  };
}
// An independently qualified adapter to the SAME canonical atomic Question store
// must implement this port. No local queue, fallback writer, sender or task writer.
// commit must independently verify provenance and atomically dedupe eventDigest
// with expectedVersion; unavailable/unknown receipt is never permission to replay.
export interface CanonicalDecisionPort {
  read(questionId: string): Promise<DecisionView>;
  receipt(eventId: string): Promise<DecisionReceipt | null>;
  commit(event: DecisionCommit): Promise<DecisionReceipt>;
}
export interface DecisionAudience {
  teamId: string;
  channelId: string;
  rootTs: string;
  userId: string;
  isDM: boolean;
}
export interface DecisionBinding extends DecisionAudience {
  questionId: string;
  taskId: string;
  originRevision: string;
  disclosureApproved: true;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const escape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const identity = (a: DecisionAudience) => [a.teamId, a.channelId, a.rootTs, a.userId, a.isDM];
function authorize(policy: SlackPolicy, binding: DecisionBinding, actor: DecisionAudience) {
  if (
    !binding.disclosureApproved ||
    actor.teamId !== policy.teamId ||
    !policy.userIds.includes(actor.userId) ||
    (actor.isDM
      ? !policy.allowDMs || !actor.channelId.startsWith("D")
      : !policy.channelIds.includes(actor.channelId)) ||
    JSON.stringify(identity(actor)) !== JSON.stringify(identity(binding))
  )
    throw new SlackPolicyError("decision_audience");
}
function view(binding: DecisionBinding, q: DecisionView) {
  if (
    q.id !== binding.questionId ||
    q.taskId !== binding.taskId ||
    q.originRevision !== binding.originRevision ||
    !Number.isInteger(q.version) ||
    q.version < 1 ||
    q.secret !== false ||
    !["open", "answered", "legacy-answered", "deferred", "skipped", "settled"].includes(q.state) ||
    typeof q.question !== "string" ||
    !Array.isArray(q.options) ||
    q.options.some((x) => typeof x !== "string") ||
    !q.question.trim() ||
    q.question.length + (q.context?.length ?? 0) + q.options.join("").length > 25000
  )
    throw new SlackStateError("Canonical decision binding is unavailable; inspect in Paseo");
}
export function decisionToken(binding: DecisionBinding, q: DecisionView) {
  return hash([identity(binding), q.id, q.taskId, q.originRevision, q.version]);
}
export function parseDecisionCommand(text: string): {
  action: DecisionAction;
  token: string;
  text: string;
} {
  const match = /^decision (answer|discuss|defer|skip|resume) ([a-f0-9]{64}) ([\s\S]+)$/u.exec(
    text,
  );
  if (!match || !match[3].trim() || match[3].length > 20000)
    throw new SlackStateError(
      "Use decision <answer|discuss|defer|skip|resume> <card-token> <text>",
    );
  return {
    action: match[1] as DecisionAction,
    token: match[2],
    text: match[3],
  };
}
function assertReplayReceipt(
  known: DecisionReceipt,
  binding: DecisionBinding,
  eventId: string,
  eventDigest: string,
) {
  if (
    known.eventId !== eventId ||
    known.eventDigest !== eventDigest ||
    known.questionId !== binding.questionId ||
    known.taskId !== binding.taskId ||
    known.originRevision !== binding.originRevision ||
    !Number.isInteger(known.version) ||
    known.version < 1
  )
    throw new SlackStateError("Conflicting decision replay; preserve original receipt");
}
export function createSlackDecisionQueue(
  policyInput: SlackPolicy,
  bindingInput: DecisionBinding,
  port: CanonicalDecisionPort,
) {
  const policy = structuredClone(policyInput),
    binding = structuredClone(bindingInput);
  return {
    async card(actor: DecisionAudience) {
      authorize(policy, binding, actor);
      const q = await port.read(binding.questionId);
      view(binding, q);
      const token = decisionToken(binding, q);
      const choices = q.options.map(
        (option, index) =>
          `${index + 1}. ${escape(option)}${q.recommended === index ? " (recommended)" : ""}`,
      );
      let actions = ["discuss"];
      if (q.state === "open") actions = ["answer", "discuss", "defer", "skip"];
      else if (["deferred", "skipped"].includes(q.state)) actions = ["resume", "discuss"];
      return {
        questionId: q.id,
        taskId: q.taskId,
        version: q.version,
        token,
        state: q.state,
        text: [
          escape(q.question),
          ...(q.context ? [escape(q.context)] : []),
          ...choices,
          `State: ${q.state}`,
          ...actions.map((action) => `decision ${action} ${token} <your text>`),
        ].join("\n"),
        reminderEligible: q.state === "open",
        delivered: false as const,
      };
    },
    async handle(event: SlackIntake) {
      authorize(policy, binding, event);
      if (event.phase !== "accepted" || !event.id || !/^\d+\.\d+$/u.test(event.messageTs))
        throw new SlackPolicyError("decision_source");
      const command = parseDecisionCommand(event.text),
        eventId = "slack-decision:" + hash([event.teamId, event.id]);
      const eventDigest = hash([identity(event), event.id, event.messageTs, event.text]);
      const known = await port.receipt(eventId);
      if (known) {
        assertReplayReceipt(known, binding, eventId, eventDigest);
        return { receipt: known, dispatchAllowed: false as const };
      }
      const q = await port.read(binding.questionId);
      view(binding, q);
      if (command.token !== decisionToken(binding, q))
        throw new SlackStateError("Stale decision card; inspect the current canonical question");
      if (
        command.action === "resume"
          ? !["deferred", "skipped"].includes(q.state)
          : command.action !== "discuss" && q.state !== "open"
      )
        throw new SlackStateError(
          "Preserve the settled decision; explicit resumption or discussion is required",
        );
      const request: DecisionCommit = {
        eventId,
        eventDigest,
        questionId: q.id,
        expectedVersion: q.version,
        taskId: q.taskId,
        originRevision: q.originRevision,
        action: command.action,
        text: command.text,
        source: {
          platform: "slack",
          account: event.teamId,
          channel: event.channelId,
          rootTs: event.rootTs,
          message: event.messageTs,
          actor: event.userId,
        },
      };
      const committed = await port.commit(request);
      if (
        committed.eventId !== eventId ||
        committed.eventDigest !== eventDigest ||
        committed.questionId !== q.id ||
        committed.taskId !== binding.taskId ||
        committed.originRevision !== binding.originRevision ||
        committed.version !== q.version + 1
      )
        throw new SlackStateError(
          "Unknown canonical commit result; reconcile receipt before retry",
        );
      return { receipt: committed, dispatchAllowed: false as const };
    },
  };
}
