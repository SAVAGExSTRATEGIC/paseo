import { Command } from "commander";
import { readFile } from "node:fs/promises";
import { connectToDaemon, resolveAgentId } from "../../utils/client.js";
import type { CommandOptions, OutputSchema } from "../../output/index.js";
import type { McpServerConfig } from "@getpaseo/protocol/agent-types";

export function addRefreshToolsOptions(cmd: Command): Command {
  return cmd
    .description("Refresh one MCP server through the live provider; never restart an agent")
    .argument("<id>", "Existing agent ID, prefix or name")
    .option("--server <name>", "MCP server name", "savagebots")
    .option("--server-config <file>", "One MCP server definition to add to a live Claude session");
}
export async function runRefreshToolsCommand(
  id: string,
  options: CommandOptions & { server?: string; serverConfig?: string },
) {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const payload = await client.fetchAgents({
      filter: { includeArchived: false },
    });
    const agentId = resolveAgentId(
      id,
      payload.entries.map((e) => e.agent),
    );
    if (!agentId) throw new Error("Agent not found");
    const serverConfig = options.serverConfig
      ? (JSON.parse(await readFile(options.serverConfig, "utf8")) as McpServerConfig)
      : undefined;
    const result = await client.refreshAgentTools(
      agentId,
      options.server ?? "savagebots",
      serverConfig,
    );
    const schema: OutputSchema<typeof result> = {
      idField: "agentId",
      columns: [
        { header: "AGENT ID", field: "agentId" },
        { header: "SERVER", field: "serverName" },
        { header: "STATE", field: "state" },
        { header: "ADOPTION", field: "adoption" },
      ],
    };
    return { type: "single" as const, data: result, schema };
  } finally {
    await client.close();
  }
}
