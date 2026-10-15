import { z } from "zod";
import { SlackPolicyError } from "./conversations.js";

export class SlackApiError extends Error {
  constructor(public readonly code: string) {
    super(`Slack API: ${code}`);
    this.name = "SlackApiError";
  }
}
export class SlackRateLimitError extends SlackApiError {
  constructor(public readonly retryAfterMs: number) {
    super("rate_limited");
  }
}
export class SlackOutcomeUnknown extends SlackApiError {
  constructor() {
    super("outcome_unknown");
  }
}
const ApiEnvelopeSchema = z
  .object({
    ok: z.boolean(),
    error: z
      .string()
      .regex(/^[a-z0-9_]+$/u)
      .optional(),
  })
  .passthrough();
const IdentitySchema = z.object({ team_id: z.string(), user_id: z.string(), bot_id: z.string() });
const PostSchema = z.object({ ts: z.string().regex(/^\d+\.\d+$/u), channel: z.string() });
const ThreadSchema = z.object({
  messages: z.array(
    z.object({
      ts: z.string(),
      user: z.string().optional(),
      metadata: z
        .object({ event_type: z.string(), event_payload: z.object({ id: z.string() }) })
        .optional(),
    }),
  ),
  has_more: z.boolean().optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});
interface ApiConfig {
  botToken: string;
  appToken: string;
  teamId: string;
  botUserId: string;
}
interface PostInput {
  id: string;
  channelId: string;
  threadTs: string;
  text: string;
  blocks?: unknown[];
}
interface ReconcileInput {
  id: string;
  channelId: string;
  threadTs: string;
}

export class SlackApi {
  constructor(
    private config: ApiConfig,
    private transport: typeof fetch = fetch,
  ) {}

  private async request(method: string, fields: object, appToken = false): Promise<unknown> {
    const token = appToken ? this.config.appToken : this.config.botToken;
    const response = await this.transport(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(fields),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000;
      throw new SlackRateLimitError(Math.min(delay, 3_600_000));
    }
    if (!response.ok) throw new SlackApiError(`http_${response.status}`);
    const payload = ApiEnvelopeSchema.parse(await response.json());
    if (!payload.ok) throw new SlackApiError(payload.error ?? "unknown_error");
    return payload;
  }

  async verifyIdentity(): Promise<void> {
    const identity = IdentitySchema.parse(await this.request("auth.test", {}));
    if (identity.team_id !== this.config.teamId || identity.user_id !== this.config.botUserId)
      throw new SlackPolicyError("slack_installation_identity");
  }

  async openSocket(): Promise<string> {
    const result = z
      .object({ url: z.string().url() })
      .parse(await this.request("apps.connections.open", {}, true));
    const url = new URL(result.url);
    if (url.protocol !== "wss:" || !url.hostname.endsWith(".slack.com"))
      throw new SlackPolicyError("socket_endpoint");
    return result.url;
  }

  async sendReply(input: PostInput): Promise<string> {
    let payload: unknown;
    try {
      payload = await this.request("chat.postMessage", {
        channel: input.channelId,
        thread_ts: input.threadTs,
        text: input.text,
        ...(input.blocks ? { blocks: input.blocks } : {}),
        parse: "none",
        link_names: false,
        unfurl_links: false,
        unfurl_media: false,
        metadata: { event_type: "paseo_delivery", event_payload: { id: input.id } },
      });
      const result = PostSchema.parse(payload);
      if (result.channel !== input.channelId) throw new SlackOutcomeUnknown();
      return result.ts;
    } catch (error) {
      if (error instanceof SlackApiError && !error.code.startsWith("http_5")) throw error;
      // A lost response or malformed acknowledgement cannot prove that a send failed.
      throw new SlackOutcomeUnknown();
    }
  }

  async reconcile(input: ReconcileInput): Promise<string | null> {
    let cursor = "";
    for (let page = 0; page < 100; page++) {
      const result = ThreadSchema.parse(
        await this.request("conversations.replies", {
          channel: input.channelId,
          ts: input.threadTs,
          limit: 100,
          include_all_metadata: true,
          ...(cursor ? { cursor } : {}),
        }),
      );
      const match = result.messages.find(
        (message) =>
          message.user === this.config.botUserId &&
          message.metadata?.event_type === "paseo_delivery" &&
          message.metadata.event_payload.id === input.id,
      );
      if (match) return match.ts;
      cursor = result.response_metadata?.next_cursor ?? "";
      if (!cursor && !result.has_more) return null;
      if (!cursor) throw new SlackApiError("incomplete_history");
    }
    throw new SlackApiError("history_page_limit");
  }
}
