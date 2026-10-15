import { ConversationStore, SlackPolicyError } from "./conversations.js";
import type { BridgeConfig } from "./config.js";
import { normalizeInteraction, normalizeMessage } from "./ingress.js";
import type { SocketConsumer } from "./socket.js";

export function createSocketConsumer(input: {
  config: BridgeConfig;
  store: ConversationStore;
  state: SocketConsumer["state"];
  failure: SocketConsumer["failure"];
}): SocketConsumer {
  return {
    appId: input.config.appId,
    state: input.state,
    failure: input.failure,
    async accept(type, payload, envelopeId) {
      try {
        if (type === "events_api") {
          const message = normalizeMessage({
            payload,
            appId: input.config.appId,
            botUserId: input.config.botUserId,
            isBound: (key) => input.store.knownConversation(key),
          });
          if (message) await input.store.accept(message);
          return;
        }
        const interaction = normalizeInteraction({
          payload,
          appId: input.config.appId,
          teamId: input.config.policy.teamId,
        });
        if (interaction) await input.store.acceptInteraction({ ...interaction, id: envelopeId });
      } catch (error) {
        if (!(error instanceof SlackPolicyError)) throw error;
        input.failure("slack_input_policy_rejected");
      }
    },
  };
}
