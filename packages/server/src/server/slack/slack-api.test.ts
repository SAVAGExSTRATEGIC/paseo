import { describe, expect, it } from "vitest";
import { SlackApi, SlackOutcomeUnknown, SlackRateLimitError } from "./slack-api.js";
const config = { botToken: "secret-bot", appToken: "secret-app", teamId: "T1", botUserId: "B1" };
const input = { id: "delivery-1", channelId: "C1", threadTs: "1.1", text: "complete" };
function response(payload: object) {
  return Response.json(payload);
}

describe("Slack provider boundary", () => {
  it("checks the actual installation before accepting work", async () => {
    const api = new SlackApi(config, async () =>
      response({ ok: true, team_id: "T2", user_id: "B1", bot_id: "bot1" }),
    );
    await expect(api.verifyIdentity()).rejects.toThrow("slack_installation_identity");
  });
  it("uses exact thread routing and durable delivery metadata with automatic unfurls disabled", async () => {
    const sent: unknown[] = [];
    const api = new SlackApi(config, async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return response({ ok: true, ts: "2.1", channel: "C1" });
    });
    expect(await api.sendReply(input)).toBe("2.1");
    expect(sent).toEqual([
      expect.objectContaining({
        channel: "C1",
        thread_ts: "1.1",
        unfurl_links: false,
        metadata: { event_type: "paseo_delivery", event_payload: { id: "delivery-1" } },
      }),
    ]);
  });
  it("honors Retry-After and never automatically retries an uncertain send", async () => {
    const limited = new SlackApi(
      config,
      async () => new Response("", { status: 429, headers: { "retry-after": "12" } }),
    );
    await expect(limited.sendReply(input)).rejects.toMatchObject({ retryAfterMs: 12_000 });
    await expect(limited.sendReply(input)).rejects.toBeInstanceOf(SlackRateLimitError);
    let attempts = 0;
    const unknown = new SlackApi(config, async () => {
      attempts++;
      throw new Error("network failure with secret-bot");
    });
    await expect(unknown.sendReply(input)).rejects.toBeInstanceOf(SlackOutcomeUnknown);
    expect(attempts).toBe(1);
  });
  it("reconciles exact delivery IDs across complete paginated history", async () => {
    const requests: unknown[] = [];
    const api = new SlackApi(config, async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1)
        return response({
          ok: true,
          messages: [],
          has_more: true,
          response_metadata: { next_cursor: "next" },
        });
      return response({
        ok: true,
        messages: [
          {
            ts: "2.1",
            user: "other",
            metadata: { event_type: "paseo_delivery", event_payload: { id: "delivery-1" } },
          },
          {
            ts: "3.1",
            user: "B1",
            metadata: { event_type: "paseo_delivery", event_payload: { id: "delivery-1" } },
          },
        ],
        has_more: false,
      });
    });
    expect(await api.reconcile(input)).toBe("3.1");
    expect(requests[1]).toMatchObject({ cursor: "next", channel: "C1", ts: "1.1" });
  });
});
