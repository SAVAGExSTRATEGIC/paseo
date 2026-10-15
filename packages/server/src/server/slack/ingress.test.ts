import { describe, expect, it } from "vitest";
import { normalizeMessage } from "./ingress.js";

function envelope(event = {}) {
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: "Ev1",
    event: {
      type: "app_mention",
      user: "U1",
      channel: "C1",
      text: "<@B1> remember teal",
      ts: "1.1",
      ...event,
    },
  };
}
describe("Slack message intake", () => {
  it("creates a mention thread and strips only the bot's mention", () => {
    const result = normalizeMessage({
      payload: envelope(),
      appId: "A1",
      botUserId: "B1",
      isBound: () => false,
    });
    expect(result).toMatchObject({ rootTs: "1.1", text: "remember teal", isDM: false });
  });
  it("continues only a bound channel thread; unrelated channel chatter is ignored", () => {
    const payload = envelope({ type: "message", text: "what color?", thread_ts: "0.1" });
    expect(
      normalizeMessage({ payload, appId: "A1", botUserId: "B1", isBound: () => false }),
    ).toBeNull();
    expect(
      normalizeMessage({ payload, appId: "A1", botUserId: "B1", isBound: () => true }),
    ).toMatchObject({ rootTs: "0.1", text: "what color?" });
  });
  it("gives top-level DMs independent roots and preserves DM thread replies", () => {
    const payload = envelope({ type: "message", channel: "D1", channel_type: "im" });
    expect(
      normalizeMessage({ payload, appId: "A1", botUserId: "B1", isBound: () => false }),
    ).toMatchObject({ rootTs: "1.1", isDM: true });
    const reply = envelope({
      type: "message",
      channel: "D1",
      channel_type: "im",
      thread_ts: "0.1",
    });
    expect(
      normalizeMessage({ payload: reply, appId: "A1", botUserId: "B1", isBound: () => false }),
    ).toMatchObject({ rootTs: "0.1", isDM: true });
  });
  it("ignores bots, edits, deletions, other app identities and unsupported event types", () => {
    for (const event of [
      { bot_id: "B2" },
      { subtype: "message_changed" },
      { subtype: "message_deleted" },
      { user: "B1" },
      { type: "reaction_added" },
    ]) {
      expect(
        normalizeMessage({
          payload: envelope(event),
          appId: "A1",
          botUserId: "B1",
          isBound: () => true,
        }),
      ).toBeNull();
    }
    expect(
      normalizeMessage({ payload: envelope(), appId: "A2", botUserId: "B1", isBound: () => true }),
    ).toBeNull();
  });
});
