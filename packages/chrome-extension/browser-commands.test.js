import { describe, expect, it, vi } from "vitest";

import { createBrowserCommandHandler } from "./browser-commands.js";

const normalTab = {
  id: 41,
  url: "https://example.com/",
  title: "Example",
  active: false,
  status: "complete",
  incognito: false,
};

function fakeChrome() {
  let onRemoved;
  return {
    tabs: {
      onRemoved: { addListener: vi.fn((listener) => (onRemoved = listener)) },
      emitRemoved: (tabId) => onRemoved?.(tabId),
      query: vi.fn(async () => [normalTab, { ...normalTab, id: 42, incognito: true }]),
      create: vi.fn(async () => ({ ...normalTab, id: 43 })),
      update: vi.fn(async () => normalTab),
      reload: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
    windows: { getAll: vi.fn(async () => [{ id: 5, incognito: false }]) },
  };
}

describe("paired Chrome browser commands", () => {
  it("lists only normal profile tabs and invalidates IDs on reconnect", async () => {
    const api = fakeChrome();
    const handler = createBrowserCommandHandler(api);
    const first = await handler.execute({
      requestId: "req-1",
      command: { command: "list_tabs", args: {} },
    });
    expect(first.payload.result.tabs).toHaveLength(1);
    const browserId = first.payload.result.tabs[0].browserId;
    const second = await handler.execute({
      requestId: "req-2",
      command: { command: "list_tabs", args: {} },
    });
    expect(second.payload.result.tabs[0].browserId).toBe(browserId);

    handler.reset();
    const stale = await handler.execute({
      requestId: "req-3",
      command: { command: "reload", args: { browserId } },
    });
    expect(stale.payload).toMatchObject({ ok: false, error: { code: "browser_tab_not_found" } });
    expect(api.tabs.reload).not.toHaveBeenCalled();
  });

  it("invalidates an ID when Chrome removes its tab", async () => {
    const api = fakeChrome();
    const handler = createBrowserCommandHandler(api);
    const listed = await handler.execute({
      requestId: "req-1",
      command: { command: "list_tabs", args: {} },
    });
    const browserId = listed.payload.result.tabs[0].browserId;
    api.tabs.emitRemoved(41);
    const stale = await handler.execute({
      requestId: "req-2",
      command: { command: "reload", args: { browserId } },
    });
    expect(stale.payload).toMatchObject({ ok: false, error: { code: "browser_tab_not_found" } });
    expect(api.tabs.reload).not.toHaveBeenCalled();
  });

  it("opens a background tab only in an existing normal window", async () => {
    const api = fakeChrome();
    const handler = createBrowserCommandHandler(api);
    const result = await handler.execute({
      requestId: "req-1",
      workspaceId: "workspace-1",
      command: { command: "new_tab", args: { url: "https://example.com/" } },
    });
    expect(result.payload).toMatchObject({ ok: true, result: { command: "new_tab" } });
    expect(api.tabs.create).toHaveBeenCalledWith({
      windowId: 5,
      active: false,
      url: "https://example.com/",
    });

    api.windows.getAll.mockResolvedValueOnce([{ id: 9, incognito: true }]);
    const denied = await handler.execute({
      requestId: "req-2",
      workspaceId: "workspace-1",
      command: { command: "new_tab", args: {} },
    });
    expect(denied.payload).toMatchObject({ ok: false, error: { code: "browser_no_host" } });
    expect(api.tabs.create).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported commands and non-HTTP navigation without contacting Chrome", async () => {
    const api = fakeChrome();
    const handler = createBrowserCommandHandler(api);
    const unsupported = await handler.execute({
      requestId: "req-1",
      command: { command: "evaluate", args: { function: "() => 1" } },
    });
    expect(unsupported.payload).toMatchObject({
      ok: false,
      error: { code: "browser_unsupported" },
    });
    expect(api.tabs.query).not.toHaveBeenCalled();

    const listed = await handler.execute({
      requestId: "req-2",
      command: { command: "list_tabs", args: {} },
    });
    const browserId = listed.payload.result.tabs[0].browserId;
    const denied = await handler.execute({
      requestId: "req-3",
      command: { command: "navigate", args: { browserId, url: "file:///tmp/private" } },
    });
    expect(denied.payload).toMatchObject({ ok: false, error: { code: "browser_denied" } });
    expect(api.tabs.update).not.toHaveBeenCalled();
  });
});
