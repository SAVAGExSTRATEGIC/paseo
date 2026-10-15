import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type {
  DaemonClient,
  FetchRecentProviderSessionsOptions,
} from "@getpaseo/client/internal/daemon-client";
import { describe, expect, it } from "vitest";
import { buildSessionsQueriesConfig, selectImportProviders } from "./import-session-queries";

class ListingClient implements Pick<DaemonClient, "fetchRecentProviderSessions"> {
  requests: FetchRecentProviderSessionsOptions[] = [];
  async fetchRecentProviderSessions(options?: FetchRecentProviderSessionsOptions) {
    this.requests.push(options ?? {});
    return { requestId: "listing", entries: [] };
  }
}

function configuration(
  client: Pick<DaemonClient, "fetchRecentProviderSessions">,
  overrides: Partial<Parameters<typeof buildSessionsQueriesConfig>[0]> = {},
) {
  return buildSessionsQueriesConfig({
    providersToFetch: ["codex"],
    visible: true,
    client,
    serverId: "host-1",
    cwd: "/workspace-1",
    query: "",
    limit: 15,
    ...overrides,
  });
}

describe("import session query lifecycle", () => {
  it("fetches only the selected provider and forwards the search and workspace", async () => {
    const client = new ListingClient();
    const configs = configuration(client, {
      providersToFetch: selectImportProviders(["claude", "codex"], "codex"),
      query: "historical investigation",
    });
    const queries = new QueryClient();
    try {
      await Promise.all(configs.map((config) => queries.fetchQuery(config)));
      expect(client.requests).toHaveLength(1);
      expect(client.requests[0]).toMatchObject({
        providers: ["codex"],
        query: "historical investigation",
        cwd: "/workspace-1",
        limit: 15,
      });
    } finally {
      queries.clear();
    }
  });

  it("retains search placeholders only within the same host and workspace", () => {
    const client = new ListingClient();
    const previous = configuration(client)[0]!;
    const data = { requestId: "old", entries: [] };
    expect(configuration(client, { query: "new" })[0]!.placeholderData(data, previous)).toBe(data);
    for (const changed of [{ serverId: "host-2" }, { cwd: "/workspace-2" }]) {
      const next = configuration(client, changed)[0]!;
      expect(next.queryKey).not.toEqual(previous.queryKey);
      expect(next.placeholderData(data, previous)).toBeUndefined();
    }
  });

  it("aborts a pending client request when its query observer is removed", async () => {
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const client = {
      fetchRecentProviderSessions(options?: FetchRecentProviderSessionsOptions) {
        signal = options?.signal;
        started();
        return new Promise<Awaited<ReturnType<DaemonClient["fetchRecentProviderSessions"]>>>(
          () => {},
        );
      },
    };
    const queries = new QueryClient();
    const observer = new QueryObserver<
      Awaited<ReturnType<DaemonClient["fetchRecentProviderSessions"]>>
    >(queries, configuration(client)[0]!);
    const unsubscribe = observer.subscribe(() => {});
    try {
      await ready;
      expect(signal?.aborted).toBe(false);
      unsubscribe();
      expect(signal?.aborted).toBe(true);
      expect(configuration(client, { visible: false })).toEqual([]);
    } finally {
      unsubscribe();
      queries.clear();
    }
  });

  it("does not query before provider capability discovery", () => {
    expect(configuration(new ListingClient(), { providersToFetch: null })).toEqual([]);
  });
});
