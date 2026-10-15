import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { PaseoAgentHandle } from "@getpaseo/client";
import { parseSlackCommand, selectSlackTarget } from "./commands.js";
import type { BridgeConfig } from "./config.js";
import {
  ConversationStore,
  SlackPolicyError,
  SlackStateError,
  type SlackBinding,
  type SlackIntake,
  type SlackTarget,
} from "./conversations.js";
import { SlackDaemon, stableOperationId } from "./daemon.js";
import { chunkOutput, redactSlackText } from "./output.js";
import { questionContinuation, questionResponse, renderQuestion } from "./questions.js";

interface RunnerInput {
  config: BridgeConfig;
  store: ConversationStore;
  hosts: ReadonlyMap<string, SlackDaemon>;
  signal: AbortSignal;
  failure: (code: string, correlation: string) => void;
}

function consumeContinuation(text: string, hashes: string[]): void {
  const hash = createHash("sha256").update(text).digest("hex");
  const index = hashes.indexOf(hash);
  if (index < 0)
    throw new SlackStateError("Another input changed the session; inspect it in Paseo");
  hashes.splice(index, 1);
}

export class ConversationRunner {
  private jobs = new Map<string, Promise<void>>();
  constructor(private input: RunnerInput) {}

  private host(target: SlackTarget): SlackDaemon {
    const host = this.input.hosts.get(target.host);
    if (!host) throw new SlackPolicyError("host_configuration");
    return host;
  }

  private sessionLink(binding: SlackBinding): string {
    return `https://app.paseo.sh/h/${encodeURIComponent(binding.target.serverId)}/agent/${encodeURIComponent(binding.agentId)}`;
  }

  private async notice(event: SlackIntake, suffix: string, text: string): Promise<void> {
    await this.input.store.enqueue(event.conversationKey, {
      id: stableOperationId(suffix, event.id),
      text: redactSlackText(text),
    });
  }

  async tick(): Promise<void> {
    for (const event of this.input.store.pending()) {
      if (event.phase !== "accepted") continue;
      try {
        const command = parseSlackCommand(event.text);
        if (command.kind !== "prompt") await this.command(event, command);
      } catch (error) {
        await this.refuse(event, error);
      }
    }
    const keys = new Set(this.input.store.pending().map((event) => event.conversationKey));
    for (const key of keys) {
      if (this.jobs.has(key)) continue;
      const job = this.conversation(key)
        .catch((error: unknown) => this.workerFailed(key, error))
        .finally(() => {
          this.jobs.delete(key);
        });
      this.jobs.set(key, job);
    }
    await this.interactions();
  }

  private async workerFailed(key: string, error: unknown): Promise<void> {
    if (this.input.signal.aborted) return;
    const event = this.input.store.pending().find((entry) => entry.conversationKey === key);
    if (!event) return;
    if (error instanceof SlackPolicyError || error instanceof SlackStateError) {
      await this.input.store.transition(event.id, event.phase, "needs_attention");
      await this.notice(
        event,
        "worker-attention",
        "This session needs attention in Paseo before work can continue. Accepted input is retained; use status and ask the operator to inspect it.",
      );
    } else {
      await this.notice(
        event,
        "worker-unavailable",
        "Paseo is temporarily unavailable. Your accepted task is retained for recovery.",
      );
      await delay(5000, undefined, { signal: this.input.signal });
    }
    this.input.failure("conversation_worker_failed", stableOperationId("conversation", key));
  }

  private target(event: SlackIntake): SlackTarget | null {
    const command = parseSlackCommand(event.text);
    const binding = this.input.store.binding(event.conversationKey);
    const selected = this.input.store.selectedTarget(event.conversationKey);
    const selection =
      command.kind === "prompt" || command.kind === "select" ? command.selection : {};
    const hasSelection = selection.host !== undefined || selection.project !== undefined;
    if (!hasSelection)
      return binding?.target ?? selected ?? selectSlackTarget(this.input.config.policy.targets, {});
    return selectSlackTarget(this.input.config.policy.targets, selection);
  }

  private async choose(event: SlackIntake): Promise<SlackTarget | null> {
    const target = this.target(event);
    if (!target) {
      const choices = this.input.config.policy.targets
        .map((entry) => `host=${entry.host} project=${entry.project}`)
        .join("\n");
      await this.notice(
        event,
        "choose",
        `Choose an allowed target by replying with one of these lines. Your task remains queued:\n${choices}`,
      );
      return null;
    }
    await this.host(target).verifyTarget(target);
    await this.input.store.selectTarget(event.conversationKey, event.userId, target);
    return target;
  }

  private async command(
    event: SlackIntake,
    command: Exclude<ReturnType<typeof parseSlackCommand>, { kind: "prompt" }>,
  ): Promise<void> {
    const binding = this.input.store.binding(event.conversationKey);
    let text: string;
    if (command.kind === "select") {
      const target = await this.choose(event);
      if (!target) return;
      text = `Selected ${target.host} / ${target.project}.`;
    } else if (command.kind === "status") {
      if (!binding) {
        text =
          "No session is bound yet. Allowed targets:\n" +
          this.input.config.policy.targets
            .map((entry) => `host=${entry.host} project=${entry.project}`)
            .join("\n");
      } else {
        const agent = await this.host(binding.target).inspect(binding);
        text = `Session ${agent.id}\nTarget ${binding.target.host} / ${binding.target.project}\nState ${agent.status}\n${this.sessionLink(binding)}`;
      }
    } else if (command.kind === "cancel") {
      if (!binding) throw new SlackStateError("No session is bound to cancel");
      await this.host(binding.target).cancel(binding);
      text = `Cancellation requested for ${binding.agentId}. Watch this thread for its final state.\n${this.sessionLink(binding)}`;
    } else if (command.kind === "answer") {
      if (!binding) throw new SlackStateError("No session is bound to answer");
      const agent = await this.host(binding.target).inspect(binding);
      const requestId = this.input.store.controlRequestId(command.token, binding.key);
      const request = agent.pendingPermissions?.find((entry) => entry.id === requestId);
      if (!request) throw new SlackStateError("That question is no longer pending");
      const response = questionResponse(request, command.text);
      const decision = await this.input.store.claimQuestion(
        {
          token: command.token,
          key: binding.key,
          actorId: event.userId,
          current: request,
          now: Date.now(),
        },
        questionContinuation(request, response),
      );
      // The claim is durable before submission. An uncertain result requires inspection, never replay.
      await agent.respondToPermission({ requestId: decision.requestId, response });
      await this.input.store.resolveControl(command.token);
      text = "Answer submitted to Paseo.";
    } else {
      if (binding)
        throw new SlackStateError(
          "This conversation is already bound; use a new thread to attach another session",
        );
      const target = await this.choose(event);
      if (!target) return;
      const agent = await this.host(target).attach({ target, agentId: command.agentId });
      if (!agent.workspaceId) throw new SlackStateError("Session has no workspace");
      const tail = await agent.timeline.refetch({ limit: 1, projection: "canonical" });
      if (tail.error) throw new SlackStateError("Cannot establish attachment history boundary");
      await this.input.store.bind({
        key: event.conversationKey,
        ownerId: event.userId,
        target,
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        cursor: { epoch: tail.epoch, seq: tail.window.maxSeq },
      });
      const attached = this.input.store.binding(event.conversationKey);
      if (!attached) throw new SlackStateError("Attachment was not persisted");
      text = `Attached ${agent.id} to this Slack conversation. Future task replies will be visible here. Existing history was not copied.\n${this.sessionLink(attached)}`;
    }
    await this.input.store.finish(event.id, [
      { id: stableOperationId("command", event.id), text: redactSlackText(text) },
    ]);
  }

  private async refuse(event: SlackIntake, error: unknown): Promise<void> {
    const text =
      error instanceof SlackStateError
        ? error.message
        : "This operation could not be authorized or completed. Use status and inspect the Paseo session.";
    await this.input.store.finish(event.id, [
      { id: stableOperationId("refused", event.id), text: redactSlackText(text) },
    ]);
    this.input.failure("slack_operation_refused", stableOperationId("event", event.id));
  }

  private async conversation(key: string): Promise<void> {
    while (!this.input.signal.aborted) {
      const event = this.input.store.pending().find((entry) => entry.conversationKey === key);
      if (!event || event.phase === "needs_attention") return;
      const command = parseSlackCommand(event.text);
      if (command.kind !== "prompt") return;
      let binding = this.input.store.binding(key);
      if (!binding) {
        const target = await this.choose(event);
        if (!target) return;
        const agent = await this.host(target).create(event, target);
        if (!agent.workspaceId) throw new SlackStateError("Created session has no workspace");
        await this.input.store.bind({
          key,
          ownerId: event.userId,
          target,
          agentId: agent.id,
          workspaceId: agent.workspaceId,
        });
        binding = this.input.store.binding(key);
      }
      if (!binding) throw new SlackStateError("Binding was not persisted");
      const agent = await this.host(binding.target).inspect(binding);
      await this.follow({ event, binding, agent, text: command.text });
    }
  }

  private async follow(input: {
    event: SlackIntake;
    binding: SlackBinding;
    agent: PaseoAgentHandle;
    text: string;
  }): Promise<void> {
    const { event, binding, agent } = input;
    let journal = Promise.resolve();
    const unsubscribe = agent.timeline.subscribe((update) => {
      const terminals: Record<string, "completed" | "failed" | "canceled"> = {
        turn_completed: "completed",
        turn_failed: "failed",
        turn_canceled: "canceled",
      };
      const terminal = terminals[update.event.type];
      if (terminal) {
        const result = terminal;
        journal = journal.then(() => this.input.store.recordTerminal(binding.key, result));
      }
    });
    try {
      await unsubscribe.ready;
      if (event.phase === "accepted") {
        await agent.refresh();
        if (agent.activeTurn) {
          await this.notice(
            event,
            "busy",
            `Session ${agent.id} is busy. Your task is queued and will start after its current turn.`,
          );
          await delay(1000, undefined, { signal: this.input.signal });
          return;
        }
        const tail = await agent.timeline.refetch({ limit: 1, projection: "canonical" });
        if (tail.error) throw new SlackStateError("Cannot checkpoint timeline before dispatch");
        await this.input.store.prepareDispatch(event.id, {
          epoch: tail.epoch,
          seq: tail.window.maxSeq,
        });
      }
      const current = this.input.store.pending().find((entry) => entry.id === event.id);
      if (!current) return;
      if (current.phase === "dispatching") {
        // The same message ID consults the daemon's durable receipt; it never chooses a new operation.
        await this.host(binding.target).send({ agent, intake: current, text: input.text });
        await this.input.store.transition(event.id, "dispatching", "running");
        await this.notice(
          event,
          "accepted",
          `Accepted by Paseo. Session ${agent.id}\n${this.sessionLink(binding)}`,
        );
      }
      await this.watch(event, binding, agent, () => journal);
    } catch (error) {
      if (this.input.signal.aborted) return;
      await this.recoverFollow(error, event, agent);
    } finally {
      await journal;
      await unsubscribe.release();
    }
  }

  private async watch(
    event: SlackIntake,
    binding: SlackBinding,
    agent: PaseoAgentHandle,
    journal: () => Promise<void>,
  ): Promise<void> {
    let progressAt = Date.now();
    for (;;) {
      if (this.input.signal.aborted) return;
      await journal();
      const active = this.input.store.pending().find((entry) => entry.id === event.id);
      if (!active) return;
      await agent.refresh();
      await this.requests(agent, binding);
      if (!active.terminal && (await this.recoverTerminal(agent, active, binding))) continue;
      if (
        active.terminal &&
        !agent.pendingPermissions?.some((request) => request.kind === "question")
      ) {
        await this.complete(agent, active);
        return;
      }
      if (Date.now() - progressAt >= 20_000) {
        await this.notice(
          event,
          `progress-${Math.floor(Date.now() / 20_000)}`,
          `Session ${agent.id}: ${agent.status}. ${agent.pendingPermissions?.length ? "Waiting for your response." : "Work continues."}`,
        );
        progressAt = Date.now();
      }
      await delay(1000, undefined, { signal: this.input.signal });
    }
  }

  private async recoverTerminal(
    agent: PaseoAgentHandle,
    active: SlackIntake,
    binding: SlackBinding,
  ): Promise<boolean> {
    if (
      agent.activeTurn ||
      agent.pendingPermissions?.length ||
      (agent.status !== "idle" && agent.status !== "error")
    )
      return false;
    const result = await this.finalText(agent, active);
    // Read after the canonical identity/result scan so an earlier idle snapshot cannot certify queued work.
    await agent.refresh();
    if (
      !result.found ||
      !result.continuationsComplete ||
      agent.activeTurn ||
      agent.pendingPermissions?.length
    )
      return false;
    if (agent.status === "error" && agent.lastError) {
      await this.input.store.recordTerminal(binding.key, "failed");
      return true;
    }
    if (result.hasAssistant && agent.status === "idle") {
      await this.input.store.recordTerminal(binding.key, "ended");
      return true;
    }
    return false;
  }

  private async requests(agent: PaseoAgentHandle, binding: SlackBinding): Promise<void> {
    for (const request of agent.pendingPermissions ?? []) {
      if (request.kind === "question") {
        await this.question(request, binding);
        continue;
      }
      const token = await this.input.store.offerPermission({
        key: binding.key,
        request,
        now: Date.now(),
      });
      const label = redactSlackText(request.title ?? request.name).slice(0, 2000);
      const detail = redactSlackText(JSON.stringify(request.input ?? {}));
      const sections = chunkOutput(`Permission required: ${label}\nRequested input:\n${detail}`);
      if (sections.length > 12) {
        await this.input.store.enqueue(binding.key, {
          id: stableOperationId("permission-large", token),
          text: `Permission requires review in Paseo: ${this.sessionLink(binding)}`,
        });
        continue;
      }
      await this.input.store.enqueue(binding.key, {
        id: stableOperationId("permission", token),
        text: `Permission required: ${label}`,
        blocks: [
          ...sections.map((text) => ({ type: "section", text: { type: "plain_text", text } })),
          {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: "paseo_allow",
                text: { type: "plain_text", text: "Approve once" },
                style: "primary",
                value: token,
              },
              {
                type: "button",
                action_id: "paseo_deny",
                text: { type: "plain_text", text: "Deny" },
                style: "danger",
                value: token,
              },
            ],
          },
        ],
      });
    }
  }

  private async question(
    request: NonNullable<PaseoAgentHandle["pendingPermissions"]>[number],
    binding: SlackBinding,
  ): Promise<void> {
    const token = await this.input.store.offerQuestion({
      key: binding.key,
      request,
      now: Date.now(),
    });
    let text: string;
    try {
      text = renderQuestion(request, token);
    } catch {
      text = `This question needs a response in Paseo: ${this.sessionLink(binding)}`;
    }
    const chunks = chunkOutput(redactSlackText(text));
    for (const [index, part] of chunks.entries()) {
      await this.input.store.enqueue(binding.key, {
        id: stableOperationId(`question-${index}`, token),
        text: part,
      });
    }
  }

  private async complete(agent: PaseoAgentHandle, active: SlackIntake): Promise<void> {
    const output = await this.finalText(agent, active);
    if (!output.found || !output.continuationsComplete)
      throw new SlackStateError("Cannot prove this task's timeline identity");
    const labels = {
      completed: "Completed",
      ended: "Turn ended (recovered)",
      failed: "Failed",
      canceled: "Canceled",
    };
    const label = active.terminal ? labels[active.terminal] : "Turn ended";
    const chunks = chunkOutput(redactSlackText(`${label}:\n${output.text}`));
    await this.input.store.finish(
      active.id,
      chunks.map((text, index) => ({ id: stableOperationId(`final-${index}`, active.id), text })),
    );
  }

  private async recoverFollow(
    error: unknown,
    event: SlackIntake,
    agent: PaseoAgentHandle,
  ): Promise<void> {
    const current = this.input.store.pending().find((entry) => entry.id === event.id);
    const unknown =
      error instanceof Error && "code" in error && error.code === "agent_request_outcome_unknown";
    if (unknown && current) {
      await this.input.store.transition(current.id, current.phase, "needs_attention");
      await this.notice(
        event,
        "uncertain",
        `Paseo needs operator reconciliation for this task. It will not be submitted with a new message ID. Inspect ${agent.id} in Paseo before continuing.`,
      );
    } else {
      await this.notice(
        event,
        "unavailable",
        `Paseo is temporarily unavailable for session ${agent.id}. Accepted work is retained; recovery will reconcile its stable message ID.`,
      );
      await delay(5000, undefined, { signal: this.input.signal });
    }
    this.input.failure("paseo_follow_failed", stableOperationId("event", event.id));
  }

  private async finalText(
    agent: PaseoAgentHandle,
    event: SlackIntake,
  ): Promise<{
    text: string;
    found: boolean;
    hasAssistant: boolean;
    continuationsComplete: boolean;
  }> {
    if (!event.startCursor) throw new SlackStateError("Missing dispatch timeline checkpoint");
    let cursor = event.startCursor;
    let found = false;
    const texts: string[] = [];
    const expected = stableOperationId("message", event.id);
    const continuations = [...event.continuationHashes];
    for (let pages = 0; pages < 1000; pages++) {
      const page = await agent.timeline.refetch({
        direction: "after",
        cursor,
        limit: 100,
        projection: "canonical",
      });
      if (page.error || page.gap || page.staleCursor || page.reset)
        throw new SlackStateError("Timeline continuity could not be proven");
      for (const entry of page.entries) {
        if (entry.item.type === "user_message") {
          const matches =
            entry.item.clientMessageId === expected || entry.item.messageId === expected;
          if (found && !matches) {
            consumeContinuation(entry.item.text, continuations);
            texts.length = 0;
          }
          if (matches) found = true;
        } else if (found && entry.item.type === "assistant_message") texts.push(entry.item.text);
      }
      if (!page.hasNewer) {
        return {
          found,
          continuationsComplete: continuations.length === 0,
          hasAssistant: texts.some((text) => text.length > 0),
          text:
            texts.join("") ||
            "The turn ended without an assistant message. Open the session for details.",
        };
      }
      if (!page.endCursor) throw new SlackStateError("Missing timeline pagination cursor");
      cursor = page.endCursor;
    }
    throw new SlackStateError(
      "Timeline exceeds the bounded recovery scan; operator inspection required",
    );
  }

  private async interactions(): Promise<void> {
    for (const receipt of this.input.store.pendingInteractions()) {
      try {
        const binding = this.input.store.binding(receipt.key);
        if (!binding) throw new SlackPolicyError("interaction_binding");
        const agent = await this.host(binding.target).inspect(binding);
        const requestId = this.input.store.controlRequestId(receipt.token, receipt.key);
        const request = agent.pendingPermissions?.find((entry) => entry.id === requestId);
        if (!request) {
          await this.input.store.resolveControl(receipt.token);
          await this.input.store.interactionState(receipt.id, "resolved");
          continue;
        }
        if (receipt.phase === "claimed") continue;
        const decision = await this.input.store.claimPermission({
          ...receipt,
          current: request,
          now: Date.now(),
        });
        await this.input.store.interactionState(receipt.id, "claimed");
        await agent.respondToPermission({
          requestId: decision.requestId,
          response: { behavior: decision.behavior },
        });
        await this.input.store.resolveControl(receipt.token);
        await this.input.store.interactionState(receipt.id, "resolved");
      } catch (error) {
        if (error instanceof SlackPolicyError || error instanceof SlackStateError) {
          await this.input.store.interactionState(receipt.id, "resolved");
          await this.input.store.enqueue(receipt.key, {
            id: stableOperationId("control-rejected", receipt.id),
            text: "This permission control is expired, already used, or no longer matches the live request. Inspect the session in Paseo; no approval was resubmitted.",
          });
        }
        this.input.failure(
          "permission_response_not_confirmed",
          stableOperationId("interaction", receipt.id),
        );
      }
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.jobs.values());
  }
}
