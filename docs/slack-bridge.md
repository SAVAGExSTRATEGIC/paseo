# Operate the Slack bridge

The Slack bridge runs separately from the Paseo daemon. It accepts messages through a dedicated internal Socket Mode app and uses the Paseo SDK for sessions and native permissions. Restart the bridge independently; restarting a shared Paseo daemon requires its owner's explicit approval.

## Configure access

Start from [deploy/slack/config.example.json](../deploy/slack/config.example.json). Replace every example value with verified installation, project catalog and host values. Use a separate private state directory. Keep the configuration outside that directory and keep credentials in Doppler, never in JSON or launch files.

Allow only the intended Slack workspace, users, channels, hosts and project roots. Host/project aliases must match exactly. The bridge checks the live server identity, project identity and path, and the selected model catalog entry. Its connection requires both valid credentials and explicit rejection of anonymous access. Loopback or private Tailscale addresses are required; the daemon stays private.

The daemon credential has broad authority. Bridge allowlists constrain this service's behavior; they do not create a daemon-scoped service identity. Native provider permission settings still apply. Verify the exact provider/account/model route's data controls and permitted usage before sending a task. Do not add a paid route or silently substitute another model.

Check the native permission mode after creation. Shared provider options or launch plugins can override a requested mode. The Codex example explicitly selects `on-request` approval and `workspace-write`; verify those settings through a harmless paused request before accepting production. The bridge refuses a configured mode mismatch before creation recovery, attachment, dispatch or permission/question response. A global auto-approval plugin needs a reviewed exception for sessions labelled `slackNativePermissions=paseo-slack-v1`; otherwise it can resolve requests before Slack's owner decides. Keep the bridge stopped until that conflict is resolved.

The manifest is [deploy/slack/manifest.json](../deploy/slack/manifest.json). Review these bot scopes:

| Scope               | Purpose                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `app_mentions:read` | Receive channel mentions                                         |
| `chat:write`        | Send replies and permission controls                             |
| `channels:history`  | Receive continued public threads and reconcile uncertain replies |
| `channels:read`     | Verify channel identity and membership during installation       |
| `im:history`        | Receive and reconcile bot DM threads                             |
| `im:read`           | Identify bot DM conversations                                    |
| `im:write`          | Open the authorized bot DM for acceptance/setup                  |

The app-level token needs only `connections:write`. Subscribe to `app_mention`, `message.channels`, and `message.im`; enable interactivity and Socket Mode. Use a dedicated app and connection. Do not reuse another bot's token or Socket Mode process.

## Build and stage a release

Use a clean committed checkout of `SAVAGExSTRATEGIC/paseo` and the repository's build/check commands. Run only relevant named test files locally; use CI for the full suite. Stage a separate release checkout with its dependencies and generated output. Keep the previous release available. Do not point production at an editable development checkout.

The compiled entrypoints are:

- `packages/server/dist/server/server/slack/main.js CONFIG`
- `packages/server/dist/server/server/slack/maintenance.js CONFIG ACTION [ARGS]`
- `packages/server/dist/server/server/slack/supervision.js RELEASE_DIRECTORY CONFIG SERVICE_DIRECTORY DOPPLER_EXECUTABLE`

Set `PASEO_SLACK_RELEASE` to the full source commit. The supervisor preparer verifies a clean committed checkout and a built entrypoint, then writes a private launcher and launchd plist for review. It does not install or start anything. It refuses to replace different existing launch files; stage an update separately, stop the bridge, review the change, and replace those files deliberately.

On macOS, keep releases, configuration and state under a persistent service root such as `~/Library/Application Support/SAVAGE/Paseo Slack`. Provision its state directory with mode `0700`. The generated launcher starts with a clean environment and fetches only `PASEO_SLACK_BOT_TOKEN`, `PASEO_SLACK_APP_TOKEN`, and the configured daemon-password secret names from `savage/dev`. Doppler fallback files are disabled. Confirm the service user's Doppler access before installation.

Validate the generated files with `plutil -lint PLIST` and `/bin/sh -n LAUNCHER`. Put the reviewed plist in `~/Library/LaunchAgents/io.savage.paseo-slack.plist`, mode `0600`. Enable and bootstrap it in the logged-in user's `gui/UID` launchd domain. This is a user LaunchAgent: the Mac must be awake and the user session available for continuous Slack intake.

## Start, stop and diagnose

With `BRIDGE_PLIST` pointing to the installed plist:

```sh
launchctl enable "gui/$(id -u)/io.savage.paseo-slack"
launchctl bootstrap "gui/$(id -u)" "$BRIDGE_PLIST"
launchctl print "gui/$(id -u)/io.savage.paseo-slack"
```

Stop the bridge gracefully before maintenance or a release switch:

```sh
launchctl bootout "gui/$(id -u)/io.savage.paseo-slack"
```

The journal's PID admission prevents another bridge or mutating maintenance process from opening it concurrently. Do not remove a live PID lock. A stopped process's stale lock is recovered by the existing PID-lock implementation.

Query `http://127.0.0.1:HEALTH_PORT/healthz` and `/readyz`. Liveness reports a fresh processing loop; readiness additionally requires Slack connectivity and verified Paseo hosts. Counts include pending inputs, deliveries and work needing attention. A ready endpoint alone is not production acceptance.

Operational logs are in `STATE/logs/bridge.jsonl`, with daily or 5 MB rotation, up to seven rotated files and 35 MB of rotated content. Events contain fixed codes and hashed correlations, not prompts, credentials or raw tool output. The launcher's stdout/stderr are discarded; inspect launchd's exit status and run the reviewed launcher in a terminal for a bootstrap failure. Never enable credential-dumping diagnostics.

An unavailable daemon retains accepted prompts and reports the outage to their originating conversations. Unknown execution outcomes and discontinuous history are held for inspection. An uncertain Slack send is reconciled by exact delivery metadata; it is never blindly posted again. Inspect held counts and the corresponding native session before resuming anything.

Messages never received while the Mac or bridge is stopped were not accepted. Ask the sender to retry those messages in a fresh message after readiness returns. Do not promise recovery of unseen Socket Mode events.

## Use the bot

Mention the bot in an allowed channel, then continue in that root thread without another mention. Every new top-level bot DM starts a conversation; a threaded DM reply continues its root. Two roots use separate sessions. Only the bound owner can control a conversation.

Use these commands in the same conversation:

```text
host=primary project=paseo Describe the harmless task
host=primary project=paseo
status
attach <full-agent-uuid> disclose=here
cancel
answer <question-token> your answer
```

Ambiguous selection lists allowed targets and keeps the original task queued. Select a target in a separate reply. A bound conversation cannot switch targets. Attachment requires an idle session in an allowed project, the host’s verified provider/model, and explicit disclosure to the current channel; existing history is not copied. Dispatch and permission/question responses recheck the live provider/model and refuse a changed or unverified route. Status and cancellation remain available after a route change. Future task replies will be visible there. One session can bind to one Slack root.

Permission buttons are bound to the owner, conversation, session and exact live request, and expire after ten minutes. Approval applies once. Denial, stale controls and repeat clicks cannot silently authorize another request. Ordinary text such as `approve` is a prompt, not permission.

`cancel` requests cancellation of the model turn. A provider can leave a shell command running after reporting the turn canceled. For a command that keeps running, open the session link in Paseo, open that agent tab's menu, and choose **Reload agent**. This closes that agent's provider processes and reopens its saved conversation; it does not restart the shared daemon. Verify the command has stopped before proceeding. Reload can change the timeline epoch. The bridge holds an input whose history continuity cannot be proven; an operator must inspect its native outcome before using the documented maintenance `resume` procedure. Do not resend the task as a new message.

Questions use an explicit `answer` token. Multiple questions show a JSON answer example with exact headers. Secret questions and unsupported native question formats must be answered in Paseo. A submission with an uncertain outcome must be inspected rather than replayed. `status` provides the session identity and link; pair the intended host in the Paseo app and verify that identity when opening it.

## Back up and restore

The running bridge snapshots its committed journal at startup and hourly. Managed snapshots in `STATE/backups` are private files with a checksum and source version. Cleanup retains at most 24 snapshots from the last 24 hours while the service is running. These files contain private Slack content and need the same operator access restrictions as the journal.

With the bridge stopped, use the compiled maintenance entrypoint:

```text
maintenance.js CONFIG backup
maintenance.js CONFIG verify SNAPSHOT
maintenance.js CONFIG restore SNAPSHOT
maintenance.js CONFIG resume INTAKE_ID
maintenance.js CONFIG resolve-canceled INTAKE_ID AGENT_ID processes-stopped
maintenance.js CONFIG prune
maintenance.js CONFIG forget CHANNEL_ID ROOT_THREAD_TS
```

`backup` and `prune` require the release environment variable. `verify` is read-only and may run against an atomic snapshot while the service is running. Other commands refuse a live service lock.

To restore, verify the snapshot, preserve the damaged directory for inspection, and provision a fresh private state directory. Make a reviewed config copy pointing to that directory, then run `restore`. Existing journals are never overwritten. Confirm the restored binding and record identities before pointing the service at the recovered directory.

Restored unfinished inputs are held, unsent replies require reconciliation, and old controls cannot approve work. Inspect each native session and receipt before using `resume INTAKE_ID` on a held prompt. Resume preserves the original creation/message identities and scans canonical history from the beginning; it does not issue a new task ID. Commands and controls are not replayed by maintenance. If the daemon cannot prove the original outcome, retain the hold and resolve it through Paseo and the operator.

Some providers rebuild message identifiers after Reload agent even though their saved conversation remains. Do not resume or resend a canceled task whose receipt can no longer be matched. After verifying its native cancellation, exact agent identity, and that its command processes have stopped, stop the bridge and use `resolve-canceled INTAKE_ID AGENT_ID processes-stopped`. This command accepts only a held prompt with a previously recorded native canceled outcome and matching binding. It closes that intake and queues one explicit operator-verified cancellation notice, without contacting the provider or dispatching any work. Keep the process/identity evidence in the operator ledger. It refuses unknown outcomes, mismatched agents, live service locks, controls and repeat resolution. Restart the bridge and verify delivery before continuing the thread.

Routine retention clears completed message/result content after 30 days and compacts completed records after 90 days. Bindings, minimal conversation origins and unresolved work remain. Messages older than the compaction boundary are rejected, preventing expired retries from executing again. `forget` refuses unfinished work, unsent deliveries and unresolved controls; after deletion the old thread stays closed to prevent replay. Start a new thread. Managed backups can retain deleted content until their retention cleanup; native Slack and Paseo histories have separate deletion controls.

## Disable, rotate and roll back

For emergency disable, boot out the bridge and run `launchctl disable "gui/$(id -u)/io.savage.paseo-slack"`. Keep the state directory intact. Revoking its dedicated Slack app token provides a second independent disconnect. Do not stop the shared Paseo daemon to disable Slack.

Rotate dedicated Slack credentials in the owning Slack app, replace their Doppler values securely, and read back identity/scopes without printing tokens. Restart only the bridge and verify readiness plus a harmless round trip. Rotating the shared daemon password is a separate coordinated change: preserve its configuration, verify activity, obtain its owner's restart approval, and check existing clients afterward.

For a code rollback, stop the bridge, take a current snapshot, select the previous compatible release, and preserve the current journal. Review additive-schema compatibility before starting it. Do not substitute an older snapshot for a healthy journal: that discards newer accepted work. The previous boundary-only source checkpoint is not an operational rollback release. If no prior operational release exists, disable the bridge while repairing it.

Record the source commit, configuration digest, service identity, snapshot verification and test receipts in the deployment's evidence ledger. Complete the real Slack/Paseo flows, recovery tests and post-restart observation on the final relevant deployment before handing it over as production accepted.

## Canonical Decision Queue interface — source preparation only

The existing native pending-permission/question controls above are not the canonical Decision Queue. `decision-queue.ts` prepares card rendering and answer/custom discussion/defer/skip/resume parity for the same canonical question/task/version, through an injected `CanonicalDecisionPort`. It has no queue, sender, model call, Linear writer or provider-resume path. Chosen/custom answer text is preserved; discussion changes no answer; settled questions do not gain answer controls/reminders. Cards escape Slack markup.

The existing command router reserves `decision ...` and refuses it explicitly until commissioned, rather than forwarding it as an agent prompt. No production port or route is enabled. Before wiring, qualify actual authenticated Slack envelope provenance through the existing consumer/journal, exact workspace/user/channel/thread/private-account and disclosure admission, and independent canonical-store source verification/atomic version and receipt deduplication. Do not emulate a native Codex human event or point this at a second JSON store.

Unknown delivery remains governed by the existing durable bridge outbox; rendering is not delivery. Unknown canonical commit acknowledgments require original receipt readback before retry; late duplicate input returns that same receipt, conflicting bodies or stale cards reject. Actual recipient confidentiality, canonical writer provenance, independent source review/current install permission and live denied-user/recovery evidence remain held. Controlled interface-port tests do not establish production authentication or application. Automatic messaging stays off; HELP remains the only session sender.

Decision reservation classifies a copy after target-selector prefixes and leading whitespace; tabs/newlines, invalid selectors and malformed decision arguments remain refused before ordinary prompt routing. Original accepted message text/source identity is retained byte-for-byte in the existing journal. Real runner/journal regressions exercise zero daemon/create/prompt/send access, not only a parser snapshot.

### Canonical Slack source port — isolated source qualification

`canonical-slack-port.ts` independently reads the existing receiver's owner-private accepted journal plus exact operator-pinned receiver config/app/workspace and question/audience/source-revision/action/version admissions. It does not accept role labels or caller answer text as evidence. A qualified binding may render its question before a future answer exists; committing an answer requires the separately admitted actual original journal event. This is a local authenticated-receiver trust boundary, not cryptographic Slack attestation or protection against a malicious process under the same OS user. It is an internal port, not an independently exposed public RPC.

The port receives the existing canonical read/mutate/reducer functions. It uses that same lock/atomic writer and stores the original-source receipt inside the same Question record, with no second question store or relay. It rechecks source under lock, aborts concurrent exact retries before a no-op write, and recovers lost acknowledgments from that original canonical receipt. Source/action/task/origin/version or original-evidence changes fail closed. No production writer, policy, installation or route is commissioned by this module. Controlled cloud transaction fixtures and private unchanged actual deployed store/reducer fixtures remain distinct from live Slack/application acceptance.
