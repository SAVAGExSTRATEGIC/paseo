import { ConversationStore, SlackPolicyError, type SlackDelivery } from "./conversations.js";
import { SlackApi, SlackApiError, SlackOutcomeUnknown, SlackRateLimitError } from "./slack-api.js";

interface OutboxInput {
  store: ConversationStore;
  api: SlackApi;
  failure: (code: string, correlation: string) => void;
  now: () => number;
}
export class SlackOutbox {
  private flushing = false;
  private channelSentAt = new Map<string, number>();
  constructor(private input: OutboxInput) {}

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const conversations = new Set<string>();
      for (const delivery of this.input.store.deliveries()) {
        if (conversations.has(delivery.key)) continue;
        conversations.add(delivery.key);
        if (delivery.nextAttemptAt > this.input.now()) continue;
        try {
          await this.deliver(delivery);
        } catch (error) {
          const code =
            error instanceof SlackPolicyError
              ? "outbox_policy_rejected"
              : "outbox_processing_failed";
          const retryAfter = error instanceof SlackRateLimitError ? error.retryAfterMs : 30_000;
          await this.input.store.deferDelivery(
            delivery.id,
            delivery.phase === "pending" ? "pending" : "uncertain",
            this.input.now() + retryAfter,
          );
          this.input.failure(code, delivery.id);
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private async deliver(delivery: SlackDelivery): Promise<void> {
    const target = this.input.store.destination(delivery.key);
    const destination = { id: delivery.id, channelId: target.channelId, threadTs: target.rootTs };
    if (delivery.phase !== "pending") {
      const confirmed = await this.input.api.reconcile(destination);
      if (confirmed) await this.input.store.deliveryState(delivery.id, "sent", confirmed);
      else {
        await this.input.store.deferDelivery(delivery.id, "uncertain", this.input.now() + 30_000);
        this.input.failure("slack_delivery_needs_reconciliation", delivery.id);
      }
      return;
    }
    const lastSent = this.channelSentAt.get(target.channelId);
    if (lastSent !== undefined && this.input.now() - lastSent < 1100) return;
    await this.input.store.beginDelivery(delivery.id);
    this.channelSentAt.set(target.channelId, this.input.now());
    try {
      const ts = await this.input.api.sendReply({
        ...destination,
        text: delivery.text,
        blocks: delivery.blocks,
      });
      await this.input.store.deliveryState(delivery.id, "sent", ts);
    } catch (error) {
      if (error instanceof SlackRateLimitError) {
        await this.input.store.deferDelivery(
          delivery.id,
          "pending",
          this.input.now() + error.retryAfterMs,
        );
      } else if (error instanceof SlackOutcomeUnknown) {
        await this.input.store.deferDelivery(delivery.id, "uncertain", this.input.now() + 30_000);
      } else if (error instanceof SlackApiError && delivery.attempts < 7) {
        await this.input.store.deferDelivery(
          delivery.id,
          "pending",
          this.input.now() + Math.min(60_000, 1000 * 2 ** delivery.attempts),
        );
      } else {
        await this.input.store.deferDelivery(delivery.id, "uncertain", this.input.now() + 60_000);
      }
      this.input.failure("slack_delivery_not_confirmed", delivery.id);
    }
  }
}
