import { describe, expect, test } from "vitest";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";

import { isPaseoToolEnabled, resolvePaseoToolPolicy } from "./paseo-tool-policy.js";

describe("Paseo tool policy", () => {
  test("defaults to all Paseo tools and resolves only the exact provider ID", () => {
    const customPolicy = {
      enabled: true,
      disabledTools: ["list_agents"],
    } satisfies ProviderPaseoToolsPolicy;

    expect(
      resolvePaseoToolPolicy("custom-claude", {
        claude: { paseoTools: { enabled: false } },
        "custom-claude": { paseoTools: customPolicy },
      }),
    ).toBe(customPolicy);
    expect(resolvePaseoToolPolicy("other-custom", { claude: { paseoTools: customPolicy } })).toBe(
      undefined,
    );
    expect(isPaseoToolEnabled(undefined, "list_agents")).toBe(true);
  });

  test("applies the provider gate and sparse disabled tools without filtering speak", () => {
    expect(isPaseoToolEnabled({ enabled: false }, "list_agents")).toBe(false);
    expect(isPaseoToolEnabled({ enabled: false }, "speak")).toBe(true);
    expect(
      isPaseoToolEnabled({ enabled: true, disabledTools: ["list_agents"] }, "list_agents"),
    ).toBe(false);
    expect(
      isPaseoToolEnabled({ enabled: true, disabledTools: ["list_agents"] }, "create_agent"),
    ).toBe(true);
  });

  test("allows an explicit browser-only provider without opening other Paseo tools", () => {
    const policy = { enabled: false, browserToolsEnabled: true };
    expect(isPaseoToolEnabled(policy, "browser_list_tabs")).toBe(true);
    expect(isPaseoToolEnabled(policy, "browser_new_tab")).toBe(true);
    expect(isPaseoToolEnabled(policy, "create_agent")).toBe(false);
    expect(isPaseoToolEnabled(policy, "list_agents")).toBe(false);
    expect(
      isPaseoToolEnabled({ ...policy, disabledTools: ["browser_new_tab"] }, "browser_new_tab"),
    ).toBe(false);
    expect(
      isPaseoToolEnabled({ enabled: false, browserToolsEnabled: false }, "browser_list_tabs"),
    ).toBe(false);
  });
});
