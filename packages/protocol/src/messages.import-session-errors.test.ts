import { describe, expect, it } from "vitest";
import { FetchRecentProviderSessionsResponseMessageSchema } from "./messages.js";

describe("import session error compatibility", () => {
  it.each([undefined, "timeout", "scan_limit", "pagination_stalled"])(
    "accepts error kind %s with legacy diagnostics",
    (kind) => {
      const message = {
        type: "fetch_recent_provider_sessions_response",
        payload: {
          requestId: "request",
          entries: [],
          providerErrors: [
            { provider: "codex", message: "internal diagnostic", ...(kind ? { kind } : {}) },
          ],
        },
      };
      expect(FetchRecentProviderSessionsResponseMessageSchema.parse(message)).toEqual(message);
    },
  );
});
