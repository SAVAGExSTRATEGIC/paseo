export const SUPPORTED_COMMANDS = ["list_tabs", "new_tab", "navigate", "reload", "close_tab"];

function isHttpUrl(url) {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function failure(requestId, code, message) {
  return {
    type: "browser.automation.execute.response",
    payload: { requestId, ok: false, error: { code, message, retryable: false } },
  };
}

export function createBrowserCommandHandler(chromeApi) {
  const tabByBrowserId = new Map();
  const browserIdByTabId = new Map();

  function forgetTab(tabId) {
    const browserId = browserIdByTabId.get(tabId);
    if (browserId) tabByBrowserId.delete(browserId);
    browserIdByTabId.delete(tabId);
  }

  chromeApi.tabs.onRemoved?.addListener((tabId) => forgetTab(tabId));

  function rememberTab(tab) {
    if (!Number.isInteger(tab.id) || tab.incognito) return null;
    let browserId = browserIdByTabId.get(tab.id);
    if (!browserId) {
      browserId = crypto.randomUUID();
      browserIdByTabId.set(tab.id, browserId);
      tabByBrowserId.set(browserId, tab.id);
    }
    return browserId;
  }

  function tabIdFor(browserId) {
    return typeof browserId === "string" ? tabByBrowserId.get(browserId) : undefined;
  }

  return {
    reset() {
      tabByBrowserId.clear();
      browserIdByTabId.clear();
    },
    // This dispatcher owns the small, exact browser command allowlist.
    // eslint-disable-next-line complexity
    async execute(request) {
      const requestId = request?.requestId;
      const command = request?.command?.command;
      const args = request?.command?.args;
      if (typeof requestId !== "string" || !SUPPORTED_COMMANDS.includes(command) || !args) {
        return failure(
          String(requestId ?? "invalid"),
          "browser_unsupported",
          "Unsupported browser command.",
        );
      }

      try {
        let result;
        if (command === "list_tabs") {
          const tabs = await chromeApi.tabs.query({});
          const liveNormalIds = new Set(
            tabs.filter((tab) => Number.isInteger(tab.id) && !tab.incognito).map((tab) => tab.id),
          );
          for (const tabId of browserIdByTabId.keys()) {
            if (!liveNormalIds.has(tabId)) forgetTab(tabId);
          }
          result = {
            command,
            tabs: tabs.flatMap((tab) => {
              const browserId = rememberTab(tab);
              return browserId
                ? [
                    {
                      browserId,
                      url: tab.url ?? "",
                      title: tab.title ?? "",
                      isActive: tab.active === true,
                      isLoading: tab.status === "loading",
                    },
                  ]
                : [];
            }),
          };
        } else if (command === "new_tab") {
          if (!request.workspaceId) {
            return failure(requestId, "browser_denied", "A workspace is required to open a tab.");
          }
          if (args.url !== undefined && !isHttpUrl(args.url)) {
            return failure(requestId, "browser_denied", "Only HTTP and HTTPS pages may be opened.");
          }
          const windows = await chromeApi.windows.getAll({ windowTypes: ["normal"] });
          const window = windows.find((item) => !item.incognito);
          if (!window || !Number.isInteger(window.id)) {
            return failure(requestId, "browser_no_host", "No approved Chrome window is available.");
          }
          const tab = await chromeApi.tabs.create({
            windowId: window.id,
            active: false,
            ...(args.url ? { url: args.url } : {}),
          });
          const browserId = rememberTab(tab);
          if (!browserId)
            return failure(requestId, "browser_unknown_error", "Tab was unavailable.");
          result = {
            command,
            browserId,
            workspaceId: request.workspaceId,
            url: args.url ?? tab.url ?? "about:blank",
          };
        } else {
          const tabId = tabIdFor(args.browserId);
          if (tabId === undefined) {
            return failure(
              requestId,
              "browser_tab_not_found",
              "The tab is not in this connection.",
            );
          }
          if (command === "navigate") {
            if (!isHttpUrl(args.url)) {
              return failure(
                requestId,
                "browser_denied",
                "Only HTTP and HTTPS pages may be opened.",
              );
            }
            await chromeApi.tabs.update(tabId, { url: args.url });
            result = { command, browserId: args.browserId, url: args.url };
          } else if (command === "reload") {
            await chromeApi.tabs.reload(tabId);
            result = { command, browserId: args.browserId };
          } else {
            await chromeApi.tabs.remove(tabId);
            forgetTab(tabId);
            result = { command, browserId: args.browserId };
          }
        }
        return {
          type: "browser.automation.execute.response",
          payload: { requestId, ok: true, result },
        };
      } catch {
        return failure(requestId, "browser_unknown_error", "The Chrome operation failed.");
      }
    },
  };
}
