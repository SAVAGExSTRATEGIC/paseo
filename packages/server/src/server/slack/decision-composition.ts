import { createHash } from "node:crypto";
import type { SlackIntake } from "./conversations.js";
import {
  decisionToken,
  type DecisionAction,
  type DecisionCommit,
  type DecisionReceipt,
  type DecisionView,
} from "./decision-queue.js";
import {
  createCanonicalSlackPort,
  readScopedSlackJournalEvent,
  type ExistingCanonicalTransactions,
  type SlackJournalPolicy,
} from "./canonical-slack-port.js";

export interface ApprovedSlackDecisionScope extends Omit<
  SlackJournalPolicy,
  "admissions"
> {
  allowedActions: DecisionAction[];
}
export interface SlackDecisionComposition {
  owns(event: SlackIntake): boolean;
  handle(
    event: SlackIntake,
  ): Promise<{ receipt: DecisionReceipt; dispatchAllowed: false }>;
  recover(
    event: SlackIntake,
  ): Promise<{ receipt: DecisionReceipt; dispatchAllowed: false } | null>;
}
const identity = (e: SlackIntake) => [
  e.id,
  e.teamId,
  e.userId,
  e.channelId,
  e.rootTs,
  e.messageTs,
  e.text,
  e.isDM,
  e.receivedAt,
  e.conversationKey,
];
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function createSlackDecisionComposition(
  input: ApprovedSlackDecisionScope,
  canonical: ExistingCanonicalTransactions,
): SlackDecisionComposition {
  const scope = structuredClone(input),
    b = scope.binding;
  if (
    !scope.allowedActions.length ||
    scope.allowedActions.some(
      (a) => !["answer", "discuss", "defer", "skip", "resume"].includes(a),
    ) ||
    new Set(scope.allowedActions).size !== scope.allowedActions.length
  )
    throw Error("Exact approved decision actions required");
  async function admitted(event: SlackIntake) {
    // Only the original persisted receiver evidence supplies identity/text/action.
    const original = readScopedSlackJournalEvent(scope, event.id);
    if (
      digest(identity(original.event)) !== digest(identity(event)) ||
      !scope.allowedActions.includes(original.command.action)
    )
      throw Error("Caller differs from scoped accepted Slack event");
    const matches = (await canonical.read()).filter(
        (q) => q.id === b.questionId,
      ),
      q = matches[0];
    if (
      matches.length !== 1 ||
      !q.decisionLoop ||
      q.decisionLoop.taskId !== b.taskId ||
      q.decisionLoop.origin.revision !== b.originRevision ||
      q.secret === true ||
      q.isSecret === true
    )
      throw Error("Approved canonical composition binding mismatch");
    const receipts = (q.decisionSlackReceipts ?? []).filter(
      (r) => r.eventId === original.eventId,
    );
    if (receipts.length > 1) throw Error("Ambiguous canonical event receipt");
    const version = receipts[0]
      ? receipts[0].version - 1
      : q.decisionLoop.version;
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      original.command.token !==
        decisionToken(b, {
          id: b.questionId,
          taskId: b.taskId,
          originRevision: b.originRevision,
          version,
        } as DecisionView)
    )
      throw Error("Stale or cross-question decision token");
    const policy: SlackJournalPolicy = {
      ...scope,
      admissions: [
        {
          originalEventId: original.event.id,
          revision: original.revision,
          expectedVersion: version,
          action: original.command.action,
        },
      ],
    };
    const port = createCanonicalSlackPort(policy, canonical);
    const request: DecisionCommit = {
      eventId: original.eventId,
      eventDigest: original.eventDigest,
      questionId: b.questionId,
      expectedVersion: version,
      taskId: b.taskId,
      originRevision: b.originRevision,
      action: original.command.action,
      text: original.command.text,
      source: {
        platform: "slack",
        account: original.event.teamId,
        channel: original.event.channelId,
        rootTs: original.event.rootTs,
        message: original.event.messageTs,
        actor: original.event.userId,
      },
    };
    return { port, request, original };
  }
  return {
    // A commissioned decision thread never treats ordinary text as agent work.
    owns: (event) =>
      event.channelId === b.channelId && event.rootTs === b.rootTs,
    async handle(event) {
      const { port, request, original } = await admitted(event),
        known = await port.receipt(request.eventId);
      if (known) return { receipt: known, dispatchAllowed: false };
      if (event.phase !== "accepted" || original.event.phase !== "accepted")
        throw Error(
          "Original event requires read-only reconciliation, not another commit",
        );
      try {
        return { receipt: await port.commit(request), dispatchAllowed: false };
      } catch (cause) {
        throw Object.assign(
          new Error(
            "Canonical decision outcome requires receipt reconciliation",
            { cause },
          ),
          { code: "canonical_slack_outcome_unknown" },
        );
      }
    },
    async recover(event) {
      const { port, request } = await admitted(event),
        receipt = await port.receipt(request.eventId);
      return receipt ? { receipt, dispatchAllowed: false } : null;
    },
  };
}
