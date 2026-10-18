import { requiredPermissionForInbound } from "../authorization/operation-permissions.js";
import { isReply } from "../session/owned-subscriptions/replies.js";
import { describe, it, expect } from "vitest";
import {
  McpToolsRefreshLane,
  refreshCodexMcpTools,
  refreshClaudeMcpTools,
} from "./mcp-tool-refresh.js";
import {
  SessionInboundMessageSchema,
  KnownStatusPayloadSchema,
} from "../../../../protocol/src/messages.js";
const input = { serverName: "savagebots" };
const config = {
  type: "stdio" as const,
  command: "/usr/bin/python3",
  args: ["/existing/guarded-bridge.py"],
};
describe("tool refresh without agent lifecycle operations", () => {
  it("requires write and execution authority before a server can be added", () => {
    expect(requiredPermissionForInbound("refresh_agent_tools_request")).toEqual([
      "workspace.write",
      "hub.execute",
    ]);
  });
  it("refuses to replace a connected Claude server definition", async () => {
    let sets = 0;
    await expect(
      refreshClaudeMcpTools(
        {
          setMcpServers: async () => {
            sets++;
            return { added: [], removed: [], errors: {} };
          },
          mcpServerStatus: async () => [{ name: "savagebots", status: "connected" }],
        },
        {},
        { ...input, serverConfig: config },
      ),
    ).rejects.toThrow("do_not_replace");
    expect(sets).toBe(0);
  });
  it("will not add missing Claude configuration by guessing", async () => {
    let sets = 0;
    await expect(
      refreshClaudeMcpTools(
        {
          setMcpServers: async () => {
            sets++;
            return { added: [], removed: [], errors: {} };
          },
          mcpServerStatus: async () => [],
        },
        {},
        input,
      ),
    ).rejects.toThrow("config_required");
    expect(sets).toBe(0);
  });
  it("accepts tool-only wire requests and replies without a prompt payload", () => {
    const request = SessionInboundMessageSchema.parse({
      type: "refresh_agent_tools_request",
      agentId: "existing",
      requestId: "refresh-1",
      serverName: "savagebots",
    });
    expect(request.type).toBe("refresh_agent_tools_request");
    const reply = {
      type: "status" as const,
      payload: {
        status: "agent_tools_refreshed" as const,
        agentId: "existing",
        requestId: "refresh-1",
        serverName: "savagebots",
        state: "queued" as const,
        toolNames: [],
        adoption: "next_model_request" as const,
      },
    };
    expect(isReply(request, reply)).toBe(true);
    expect(isReply({ ...request, requestId: "other-client" }, reply)).toBe(false);
    expect(
      KnownStatusPayloadSchema.parse({
        status: "agent_tools_refreshed",
        agentId: "existing",
        requestId: "refresh-1",
        serverName: "savagebots",
        state: "queued",
        toolNames: [],
        adoption: "next_model_request",
      }).status,
    ).toBe("agent_tools_refreshed");
    expect(() =>
      SessionInboundMessageSchema.parse({ ...request, serverName: "bad/name" }),
    ).toThrow();
  });
  it("only queues native Codex config reload and reads that exact thread", async () => {
    const calls: unknown[] = [];
    const client = {
      request: async (method: string, params?: unknown) => {
        calls.push([method, params]);
        return method === "mcpServerStatus/list"
          ? {
              data: [
                {
                  name: "savagebots",
                  tools: { savagebots_acquire: {}, savagebots_release: {} },
                  toolsError: null,
                },
              ],
            }
          : {};
      },
    };
    expect(await refreshCodexMcpTools(client, "native-running-thread", input)).toEqual({
      ...input,
      state: "connected",
      toolNames: ["savagebots_acquire", "savagebots_release"],
      adoption: "next_model_request",
    });
    expect(calls).toEqual([
      ["config/mcpServer/reload", undefined],
      [
        "mcpServerStatus/list",
        {
          threadId: "native-running-thread",
          serverName: "savagebots",
          detail: "toolsAndAuthOnly",
        },
      ],
    ]);
  });
  it("does not claim that queued Codex refresh already adopted tools", async () => {
    const r = await refreshCodexMcpTools({ request: async () => ({ data: [] }) }, "busy", input);
    expect(r.state).toBe("queued");
    expect(r.toolNames).toEqual([]);
  });
  it("refuses supplied Codex config before touching the runtime", async () => {
    let calls = 0;
    await expect(
      refreshCodexMcpTools(
        {
          request: async () => {
            calls++;
          },
        },
        "busy",
        { ...input, serverConfig: config },
      ),
    ).rejects.toThrow("saved_first");
    expect(calls).toBe(0);
  });
  it("does not replay native reload on an unknown/failed response", async () => {
    const calls: string[] = [];
    await expect(
      refreshCodexMcpTools(
        {
          request: async (method) => {
            calls.push(method);
            throw Error("lost connection");
          },
        },
        "busy",
        input,
      ),
    ).rejects.toThrow();
    expect(calls).toEqual(["config/mcpServer/reload"]);
  });
  it("adds Claude server while retaining SDK servers and the running query", async () => {
    const existing = {
      paseo: { type: "http" as const, url: "http://127.0.0.1/mcp" },
    };
    let added = false;
    const seen: unknown[] = [];
    const query = {
      setMcpServers: async (servers: unknown) => {
        seen.push(servers);
        added = true;
        return { added: ["savagebots"], removed: [], errors: {} };
      },
      mcpServerStatus: async () => [
        { name: "paseo", status: "connected" },
        ...(added
          ? [
              {
                name: "savagebots",
                status: "connected",
                tools: [{ name: "savagebots_acquire" }],
              },
            ]
          : []),
      ],
    };
    expect(
      await refreshClaudeMcpTools(query, existing, {
        ...input,
        serverConfig: config,
      }),
    ).toEqual({
      ...input,
      state: "connected",
      toolNames: ["savagebots_acquire"],
      adoption: "next_model_request",
    });
    expect(seen).toEqual([{ ...existing, savagebots: config }]);
    expect(existing).not.toHaveProperty("savagebots");
  });
  it("never reconnects an already connected Claude server or a failed action transport", async () => {
    let sets = 0;
    const query = {
      setMcpServers: async () => {
        sets++;
        return { added: [], removed: [], errors: {} };
      },
      mcpServerStatus: async () => [{ name: "savagebots", status: "connected" }],
    };
    await refreshClaudeMcpTools(query, {}, input);
    expect(sets).toBe(0);
    query.mcpServerStatus = async () => [{ name: "savagebots", status: "failed" }];
    await expect(
      refreshClaudeMcpTools(query, {}, { ...input, serverConfig: config }),
    ).rejects.toThrow("reconcile");
    expect(sets).toBe(0);
  });
  it("fails partial Claude changes without a retry or restart", async () => {
    let sets = 0;
    await expect(
      refreshClaudeMcpTools(
        {
          setMcpServers: async () => {
            sets++;
            return {
              added: [],
              removed: [],
              errors: { savagebots: "private error" },
            };
          },
          mcpServerStatus: async () => [],
        },
        {},
        { ...input, serverConfig: config },
      ),
    ).rejects.toThrow("reconcile");
    expect(sets).toBe(1);
  });
  it("coalesces duplicates and rejects different concurrent configuration", async () => {
    const lane = new McpToolsRefreshLane();
    let finish!: () => void;
    let runs = 0;
    const action = async () => {
      runs++;
      await new Promise<void>((r) => {
        finish = r;
      });
      return {
        ...input,
        state: "connected" as const,
        toolNames: [],
        adoption: "next_model_request" as const,
      };
    };
    const first = lane.run(input, action),
      duplicate = lane.run(input, action);
    expect(first).toBe(duplicate);
    await expect(lane.run({ serverName: "different" }, action)).rejects.toThrow("busy");
    finish();
    await first;
    expect(runs).toBe(1);
  });
});
