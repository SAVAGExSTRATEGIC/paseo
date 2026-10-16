import { readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { SlackPolicySchema, SlackPolicyError } from "./conversations.js";

const HostSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  serverId: z.string().min(1),
  passwordEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
  agentConfig: z.object({
    provider: z.string().regex(/^[^/\s]+\/[^\s]+$/u, "Use provider/model from the actual catalog"),
    modeId: z.string().optional(),
    thinkingOptionId: z.string().optional(),
    options: z.record(z.string(), z.json()).optional(),
  }),
});
export const BridgeConfigSchema = z
  .object({
    appId: z.string().regex(/^A[A-Z0-9]+$/u),
    botUserId: z.string().regex(/^U[A-Z0-9]+$/u),
    dataDirectory: z.string().refine(isAbsolute, "Use an absolute private data directory"),
    healthPort: z.number().int().min(1024).max(65535),
    policy: SlackPolicySchema,
    hosts: z.array(HostSchema).min(1),
  })
  .superRefine((config, context) => {
    const aliases = new Set<string>();
    for (const host of config.hosts) {
      if (aliases.has(host.name))
        context.addIssue({ code: "custom", message: "Host aliases must be unique" });
      aliases.add(host.name);
    }
    const targets = new Set<string>();
    for (const target of config.policy.targets) {
      const identity = JSON.stringify([target.host, target.project]);
      if (targets.has(identity))
        context.addIssue({ code: "custom", message: "Target aliases must be unique" });
      targets.add(identity);
      const host = config.hosts.find((entry) => entry.name === target.host);
      if (!host || host.serverId !== target.serverId)
        context.addIssue({
          code: "custom",
          message: "Every target must name a configured matching host",
        });
    }
  });
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

export async function readBridgeConfig(file: string): Promise<BridgeConfig> {
  const config = BridgeConfigSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const directory = await realpath(config.dataDirectory);
  for (const marker of ["config.json", "agents"]) {
    try {
      await realpath(`${directory}/${marker}`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    throw new SlackPolicyError("bridge_data_must_not_be_daemon_home");
  }
  return config;
}

export function requireSecret(environment: NodeJS.ProcessEnv, key: string): string {
  const value = environment[key]?.trim();
  if (!value) throw new SlackPolicyError("missing_required_credential");
  return value;
}
