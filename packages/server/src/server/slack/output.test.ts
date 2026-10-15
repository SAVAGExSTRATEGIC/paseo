import { describe, expect, it } from "vitest";
import { chunkOutput, redactSlackText } from "./output.js";
describe("Slack safe output", () => {
  it("keeps every character of a long Unicode result in readable bounded chunks", () => {
    const text = `${"result 👩🏽‍💻 line\n".repeat(2500)}last character ✓`;
    const chunks = chunkOutput(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 2900 && chunk.length > 0)).toBe(true);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/u.test(chunk))).toBe(true);
  });
  it("redacts credentials and disables injected Slack mentions", () => {
    const result = redactSlackText(
      'Bearer secret123 xoxb-123-abc xapp-1-abc sk-123456789012345678901234567890 API_KEY="canary" <!channel> <@U1>',
    );
    for (const secret of [
      "secret123",
      "xoxb-123-abc",
      "xapp-1-abc",
      "sk-123456789012345678901234567890",
      "canary",
      "<!channel>",
      "<@U1>",
    ])
      expect(result).not.toContain(secret);
    expect(result).toContain("[REDACTED]");
  });
});
