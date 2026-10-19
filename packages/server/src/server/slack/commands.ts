import { SlackStateError, type SlackTarget } from "./conversations.js";

interface TargetSelection {
  host?: string;
  project?: string;
}
export type SlackCommand =
  | { kind: "decision-unconfigured" }
  | { kind: "status" }
  | { kind: "cancel" }
  | { kind: "answer"; token: string; text: string }
  | { kind: "attach"; agentId: string }
  | { kind: "select"; selection: TargetSelection }
  | { kind: "prompt"; text: string; selection: TargetSelection };

export function parseSlackCommand(text: string): SlackCommand {
  // Classify a copy only: never rewrite accepted event text or its provenance.
  // Even invalid/duplicate selector prefixes cannot turn a reserved command
  // into an ordinary prompt. Normal selector validation remains below.
  let decisionCandidate = text.trimStart();
  for (;;) {
    const prefix = /^(?:host|project)=[^\s]*(?:\s+|$)/u.exec(decisionCandidate);
    if (!prefix) break;
    decisionCandidate = decisionCandidate.slice(prefix[0].length).trimStart();
  }
  if (/^decision(?:\s|$)/u.test(decisionCandidate)) return { kind: "decision-unconfigured" };
  if (text === "status") return { kind: "status" };
  if (text === "cancel") return { kind: "cancel" };
  if (text.startsWith("answer ")) {
    const match =
      /^answer ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) ([\s\S]+)$/u.exec(
        text,
      );
    if (!match) throw new SlackStateError("Use: answer <question-token> <answer text or JSON>");
    return { kind: "answer", token: match[1], text: match[2] };
  }
  if (text.startsWith("attach ")) {
    const match = /^attach ([0-9a-f-]{36}) disclose=here$/u.exec(text);
    if (!match)
      throw new SlackStateError(
        "Use: attach <full-agent-id> disclose=here. New replies will be visible in this Slack conversation.",
      );
    return { kind: "attach", agentId: match[1] };
  }
  const selection: TargetSelection = {};
  let prompt = text;
  for (;;) {
    const match = /^(host|project)=([a-z0-9._-]+)(?:\s+|$)/u.exec(prompt);
    if (!match) break;
    const field = match[1] === "host" ? "host" : "project";
    if (selection[field] !== undefined)
      throw new SlackStateError("Specify each target selector once");
    selection[field] = match[2];
    prompt = prompt.slice(match[0].length);
  }
  if (/^(host|project)=/u.test(prompt))
    throw new SlackStateError("Use the exact host and project aliases listed by status");
  if (prompt.length === 0) return { kind: "select", selection };
  return { kind: "prompt", text: prompt, selection };
}

export function selectSlackTarget(
  targets: SlackTarget[],
  selection: TargetSelection,
): SlackTarget | null {
  const matches = targets.filter(
    (target) =>
      (selection.host === undefined || target.host === selection.host) &&
      (selection.project === undefined || target.project === selection.project),
  );
  if (matches.length === 0) throw new SlackStateError("That host/project is not allowed");
  return matches.length === 1 ? matches[0] : null;
}
