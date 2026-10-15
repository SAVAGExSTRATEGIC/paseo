import { expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginHookHandlers } from "./index.js";

const paseo = createPaseoApi(
  new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "lifecycle-unit" }),
);

test("removing an old registration twice preserves a newer registration for the same hook", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const remove = hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: "old" };
  });
  remove();
  hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: "new" };
  });
  remove();
  const output = await hooks.invoke(
    "operation",
    "before",
    "workspace.create",
    {
      source: { kind: "directory", path: "/project" },
    },
    paseo,
  );
  expect(output).toEqual({ source: { kind: "directory", path: "/project" }, title: "new" });
});

test("before hooks compose returned requests and preserve the original input", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: "first" };
  });
  hooks.before("workspace.create", () => {
    return;
  });
  hooks.before("workspace.create", ({ request }) => {
    return { ...request, title: request.title + ":second" };
  });
  const input = { source: { kind: "directory", path: "/project" } };
  expect(await hooks.invoke("operation", "before", "workspace.create", input, paseo)).toEqual({
    source: { kind: "directory", path: "/project" },
    title: "first:second",
  });
  expect(input).toEqual({ source: { kind: "directory", path: "/project" } });
});

test("teardown aborts an active callback and removes its registrations", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("workspace.create", async (_input, context) => {
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener(
        "abort",
        () => {
          reject(new Error("Hook aborted"));
        },
        { once: true },
      );
    });
  });
  const invocation = hooks.invoke(
    "operation",
    "before",
    "workspace.create",
    {
      source: { kind: "directory", path: "/project" },
    },
    paseo,
  );
  hooks.close();
  await expect(invocation).rejects.toThrow("Hook aborted");
  expect(hooks.catalog()).toEqual({ events: [], before: [] });
});

test("session-open hooks reject changes to session identity instead of silently ignoring them", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("agent.session_open", ({ request }) => {
    return { ...request, provider: "another-provider" };
  });
  await expect(
    hooks.invoke(
      "operation",
      "before",
      "agent.session_open",
      {
        agentId: "agent",
        workspaceId: "workspace",
        provider: "claude",
        cwd: "/project",
        reason: "resume",
        purpose: "interactive",
        env: {},
      },
      paseo,
    ),
  ).rejects.toThrow("agent.session_open hooks can only change env and mcpServers");
});

const sessionOpenRequest = {
  agentId: "agent",
  workspaceId: "workspace",
  provider: "codex",
  cwd: "/project",
  reason: "resume" as const,
  purpose: "interactive" as const,
  env: {},
  mcpServers: { scoped: { type: "http" as const, url: "https://example.com/scoped" } },
};

test("session-open hooks compose MCP additions while preserving scoped definitions", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("agent.session_open", ({ request }) => ({
    ...request,
    mcpServers: { ...request.mcpServers, fleet: { type: "stdio", command: "fleet" } },
  }));
  const output = await hooks.invoke(
    "operation",
    "before",
    "agent.session_open",
    sessionOpenRequest,
    paseo,
  );
  expect(output.mcpServers).toEqual({
    ...sessionOpenRequest.mcpServers,
    fleet: { type: "stdio", command: "fleet" },
  });
  expect(sessionOpenRequest.mcpServers).toEqual({
    scoped: { type: "http", url: "https://example.com/scoped" },
  });
});

test("legacy session-open hooks that omit MCP definitions retain the existing map", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("agent.session_open", ({ request }) => {
    const { mcpServers: _servers, ...legacy } = request;
    return { ...legacy, env: { REGION: "eu" } };
  });
  const output = await hooks.invoke(
    "operation",
    "before",
    "agent.session_open",
    sessionOpenRequest,
    paseo,
  );
  expect(output).toEqual({ ...sessionOpenRequest, env: { REGION: "eu" } });
});

test("history-only opens reject MCP migration", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("agent.session_open", ({ request }) => ({ ...request, mcpServers: {} }));
  await expect(
    hooks.invoke(
      "operation",
      "before",
      "agent.session_open",
      { ...sessionOpenRequest, purpose: "history" },
      paseo,
    ),
  ).rejects.toThrow("history hooks cannot change mcpServers");
});

test("session-open hooks reject invalid MCP transports before opening a provider", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before(
    "agent.session_open",
    ({ request }) => ({ ...request, mcpServers: { broken: { type: "http" } } }) as typeof request,
  );
  await expect(
    hooks.invoke("operation", "before", "agent.session_open", sessionOpenRequest, paseo),
  ).rejects.toThrow();
});
