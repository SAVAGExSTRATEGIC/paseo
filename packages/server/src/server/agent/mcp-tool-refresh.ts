import type { McpServerConfig } from "@getpaseo/protocol/agent-types";

export interface McpToolsRefreshInput {
  serverName: string;
  /** Add one server to a live Claude SDK session. Existing definitions are retained. */
  serverConfig?: McpServerConfig;
}
export interface McpToolsRefreshResult {
  serverName: string;
  state: "queued" | "connected";
  toolNames: string[];
  adoption: "next_model_request";
}

/** Coalesce duplicate requests; never replay a failed or unknown native mutation. */
export class McpToolsRefreshLane {
  private pending: Promise<McpToolsRefreshResult> | null = null;
  private key: string | null = null;
  run(input: McpToolsRefreshInput, refresh: () => Promise<McpToolsRefreshResult>) {
    const key = JSON.stringify(input);
    if (this.pending) {
      if (this.key !== key) return Promise.reject(new Error("mcp_refresh_busy"));
      return this.pending;
    }
    this.key = key;
    const pending = Promise.resolve().then(refresh);
    this.pending = pending;
    void pending
      .finally(() => {
        if (this.pending === pending) {
          this.pending = null;
          this.key = null;
        }
      })
      .catch(() => undefined);
    return pending;
  }
}

interface Rpc {
  request(method: string, params?: unknown): Promise<unknown>;
}
export async function refreshCodexMcpTools(
  client: Rpc,
  threadId: string,
  input: McpToolsRefreshInput,
): Promise<McpToolsRefreshResult> {
  // This API reads disk configuration. Never pretend a supplied config was applied.
  if (input.serverConfig) throw new Error("codex_mcp_config_must_be_saved_first");
  await client.request("config/mcpServer/reload");
  const raw = (await client.request("mcpServerStatus/list", {
    threadId,
    serverName: input.serverName,
    detail: "toolsAndAuthOnly",
  })) as {
    data?: Array<{
      name?: string;
      tools?: Record<string, unknown>;
      toolsError?: unknown;
    }>;
  };
  if (!Array.isArray(raw?.data)) throw new Error("invalid_mcp_refresh_readback");
  const server = raw.data.find((s) => s.name === input.serverName);
  if (server?.toolsError) throw new Error("mcp_refresh_connection_failed");
  const toolNames = Object.keys(server?.tools ?? {}).sort();
  return {
    serverName: input.serverName,
    state: toolNames.length ? "connected" : "queued",
    toolNames,
    adoption: "next_model_request",
  };
}

export interface ClaudeMcpRefreshQuery {
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<{
    added: string[];
    removed: string[];
    errors: Record<string, string>;
  }>;
  mcpServerStatus(): Promise<Array<{ name: string; status: string; tools?: { name: string }[] }>>;
}
export async function refreshClaudeMcpTools(
  query: ClaudeMcpRefreshQuery,
  existing: Record<string, McpServerConfig>,
  input: McpToolsRefreshInput,
): Promise<McpToolsRefreshResult> {
  // Do not reconnect a server that could be executing a website action.
  const before = await query.mcpServerStatus();
  const current = before.find((s) => s.name === input.serverName);
  if (current?.status === "connected" && input.serverConfig) {
    throw new Error("mcp_server_already_connected_do_not_replace");
  }
  if (current?.status !== "connected") {
    if (current) throw new Error("mcp_server_not_connected_reconcile_before_retry");
    if (!input.serverConfig) throw new Error("mcp_server_config_required");
    if (
      existing[input.serverName] &&
      JSON.stringify(existing[input.serverName]) !== JSON.stringify(input.serverConfig)
    ) {
      throw new Error("mcp_server_config_conflict");
    }
    // Keep all previously SDK-added servers. Settings/plugin servers are retained by the SDK.
    const result = await query.setMcpServers({
      ...existing,
      [input.serverName]: input.serverConfig,
    });
    if (result.removed.length || Object.keys(result.errors).length)
      throw new Error("mcp_refresh_partial_or_failed_reconcile_before_retry");
  }
  const after = await query.mcpServerStatus();
  if (
    before.some(
      (s) =>
        s.status === "connected" &&
        !after.some((a) => a.name === s.name && a.status === "connected"),
    )
  ) {
    throw new Error("mcp_refresh_existing_connection_changed");
  }
  const server = after.find((s) => s.name === input.serverName);
  if (server?.status !== "connected") throw new Error("mcp_refresh_connection_failed");
  return {
    serverName: input.serverName,
    state: "connected",
    toolNames: (server.tools ?? []).map((t) => t.name).sort(),
    adoption: "next_model_request",
  };
}
