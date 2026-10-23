import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { i18n } from "@/i18n/i18next";

type RecentSessionsResponse = Awaited<
  ReturnType<Pick<DaemonClient, "fetchRecentProviderSessions">["fetchRecentProviderSessions"]>
>;

type SessionsQueryKey = ReadonlyArray<string | number | null>;

export function buildSessionsQueryKey(input: {
  serverId: string | null;
  cwd: string | null;
  query: string;
  limit: number;
  provider?: string;
}): SessionsQueryKey {
  return [
    "recent-provider-sessions",
    input.serverId,
    input.cwd,
    input.query,
    input.limit,
    ...(input.provider === undefined ? [] : [input.provider]),
  ];
}

interface SessionsQueryConfig {
  queryKey: SessionsQueryKey;
  enabled: boolean;
  // A provider that cannot answer stays broken until the user asks again. React
  // Query's default retry would keep the header spinner turning and pile up
  // in-flight daemon requests behind a dead provider (#2512).
  retry: false;
  placeholderData: (
    previousData: RecentSessionsResponse | undefined,
    previousQuery: { queryKey: readonly unknown[] } | undefined,
  ) => RecentSessionsResponse | undefined;
  queryFn: (context: { signal: AbortSignal }) => Promise<RecentSessionsResponse>;
}

export function buildSessionsQueriesConfig(args: {
  providersToFetch: AgentProvider[] | null;
  visible: boolean;
  client: Pick<DaemonClient, "fetchRecentProviderSessions"> | null;
  serverId: string | null;
  cwd: string | null;
  query: string;
  limit: number;
  hostDisconnectedMessage?: string;
}): SessionsQueryConfig[] {
  const {
    providersToFetch,
    visible,
    client,
    serverId,
    cwd,
    query,
    limit,
    hostDisconnectedMessage,
  } = args;
  if (providersToFetch === null || !visible) return [];
  const enabled = visible && Boolean(client);
  return providersToFetch.map((provider) => ({
    queryKey: buildSessionsQueryKey({ serverId, cwd, query, limit, provider }),
    enabled,
    retry: false as const,
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === serverId && previousQuery.queryKey[2] === cwd
        ? previousData
        : undefined,
    queryFn: async ({ signal }) => {
      if (!client) {
        throw new Error(hostDisconnectedMessage ?? i18n.t("workspace.terminal.hostDisconnected"));
      }
      return await client.fetchRecentProviderSessions({
        signal,
        ...(cwd ? { cwd } : {}),
        providers: [provider],
        limit,
        ...(query ? { query } : {}),
      });
    },
  }));
}

export function selectImportProviders(
  available: AgentProvider[] | null,
  selected: string,
): AgentProvider[] | null {
  return available === null || selected === "__all__"
    ? available
    : available.filter((provider) => provider === selected);
}
