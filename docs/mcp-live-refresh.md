# MCP tools on a live Paseo agent

`paseo agent refresh-tools AGENT --server savagebots` reaches the existing provider session. It never invokes agent reload, interrupt, archive/unarchive, model turn, resume, account selection or process restart. An unloaded or unsupported provider fails closed.

Codex reloads its MCP configuration from its existing CODEX_HOME. Save the server there first; supplied server definitions are rejected. The native app-server queues refresh for loaded threads. The result distinguishes a queued refresh from a connected tool catalog, with adoption at the next model request. A current in-flight model request keeps its original catalog.

For Claude, if the server is absent from the live query, add one reviewed definition with `--server-config FILE`. The file contains one standard MCP server definition, not a whole configuration. Existing SDK servers are preserved; the SDK retains file/plugin servers. Connected servers are inspected without reconnecting them. Failed/pending servers are left alone until their owner reconciles any unknown browser action outcome. Control requests use the existing Query; no ensureQuery or new process.

For SavageBots, use the installed guarded bridge and canonical browser policy. Successful tool connection does not acquire a browser lease or prove native task/Linear/profile custody. Those checks remain required for every actual browser operation. Tool refresh starts no model conversation and reads no browser page.

Duplicate in-flight requests share a result; different concurrent requests fail busy. A native timeout or partial failure is not retried automatically. Reconcile status before a human-authorized retry. Only safe tool names and connection state are returned; native config errors and credentials are not broadcast.

Deployment limitation: this source adds a new API. It cannot make an already-running daemon that lacks that API execute new code. Do not use debugger injection, patch process memory, replace live bundles or restart active jobs to manufacture adoption. Admit an updated signed runtime through the existing Paseo release path after preserving active work. Then use refresh-tools on existing loaded agents and verify the catalog and unchanged native identities separately. Source tests and CLI configuration checks are not live-session acceptance.

Model-free regression: mcp-tool-refresh.test.ts checks exact native calls, queued versus observed state, preservation, contention and failed/unknown outcomes. It does not certify the installed daemon, subscription billing, all SDK versions, or a live model turn. Retain SAV2-1381 until actual runtime and agent readback are complete.
