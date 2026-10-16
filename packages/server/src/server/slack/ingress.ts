import { z } from "zod";
import { conversationKey, type SlackMessage } from "./conversations.js";

const EnvelopeSchema = z.object({
  type: z.literal("event_callback"),
  team_id: z.string().min(1),
  api_app_id: z.string().min(1),
  event_id: z.string().min(1),
  event: z.unknown(),
});
const EventSchema = z.object({
  type: z.enum(["app_mention", "message"]),
  user: z.string().min(1),
  channel: z.string().min(1),
  text: z.string().max(40_000),
  ts: z.string().regex(/^\d+\.\d+$/u),
  thread_ts: z
    .string()
    .regex(/^\d+\.\d+$/u)
    .optional(),
  channel_type: z.string().optional(),
  bot_id: z.string().optional(),
  subtype: z.string().optional(),
});
interface NormalizeInput {
  payload: unknown;
  appId: string;
  botUserId: string;
  isBound: (key: string) => boolean;
}

export function normalizeMessage(input: NormalizeInput): SlackMessage | null {
  const envelope = EnvelopeSchema.safeParse(input.payload);
  if (!envelope.success || envelope.data.api_app_id !== input.appId) return null;
  const parsed = EventSchema.safeParse(envelope.data.event);
  if (!parsed.success) return null;
  const event = parsed.data;
  const fromBot = event.bot_id !== undefined || event.user === input.botUserId;
  if (fromBot || event.subtype !== undefined) return null;
  const isDM = event.channel_type === "im" && event.channel.startsWith("D");
  const rootTs = event.thread_ts ?? event.ts;
  const key = conversationKey({ teamId: envelope.data.team_id, channelId: event.channel, rootTs });
  const isMention = event.type === "app_mention";
  if (!isMention && !isDM && !input.isBound(key)) return null;
  const text = event.text.replaceAll(`<@${input.botUserId}>`, "").trim();
  if (text.length === 0) return null;
  return {
    id: envelope.data.event_id,
    teamId: envelope.data.team_id,
    userId: event.user,
    channelId: event.channel,
    rootTs,
    messageTs: event.ts,
    text,
    isDM,
  };
}

const InteractionSchema = z.object({
  type: z.literal("block_actions"),
  api_app_id: z.string(),
  team: z.object({ id: z.string() }),
  user: z.object({ id: z.string() }),
  channel: z.object({ id: z.string() }),
  message: z.object({
    ts: z.string().regex(/^\d+\.\d+$/u),
    thread_ts: z
      .string()
      .regex(/^\d+\.\d+$/u)
      .optional(),
  }),
  actions: z
    .array(z.object({ action_id: z.enum(["paseo_allow", "paseo_deny"]), value: z.string().uuid() }))
    .length(1),
});
interface NormalizeInteractionInput {
  payload: unknown;
  appId: string;
  teamId: string;
}
export function normalizeInteraction(input: NormalizeInteractionInput) {
  const parsed = InteractionSchema.safeParse(input.payload);
  if (!parsed.success) return null;
  const interaction = parsed.data;
  if (interaction.api_app_id !== input.appId || interaction.team.id !== input.teamId) return null;
  const action = interaction.actions[0];
  const behavior: "allow" | "deny" = action.action_id === "paseo_allow" ? "allow" : "deny";
  return {
    token: action.value,
    actorId: interaction.user.id,
    behavior,
    key: conversationKey({
      teamId: interaction.team.id,
      channelId: interaction.channel.id,
      rootTs: interaction.message.thread_ts ?? interaction.message.ts,
    }),
  };
}
