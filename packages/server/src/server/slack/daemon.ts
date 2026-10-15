import { createHash } from "node:crypto";
import { createPaseoApi, type PaseoAgentConfig, type PaseoAgentHandle } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SlackBinding, SlackIntake, SlackTarget } from "./conversations.js";
import { SlackPolicyError, SlackStateError } from "./conversations.js";

export interface SlackHostConfig {
  url: string;
  serverId: string;
  authHeader?: string;
  password?: string;
  agentConfig: PaseoAgentConfig;
}

export function stableOperationId(namespace: string, identity: string): string {
  return `slack-${namespace}-${createHash("sha256").update(identity).digest("hex")}`;
}

/** Owns one authenticated private daemon connection, separate from its agent runtime. */
export class SlackDaemon {
  private driver: DaemonClient;
  readonly api;

  constructor(private config: SlackHostConfig) {
    const endpoint = new URL(config.url);
    const privateHost =
      endpoint.hostname === "127.0.0.1" ||
      endpoint.hostname === "[::1]" ||
      endpoint.hostname.endsWith(".ts.net");
    if (!privateHost) throw new SlackPolicyError("private_daemon_endpoint");
    if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:")
      throw new SlackPolicyError("daemon_transport");
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw new SlackPolicyError("daemon_url_credentials");
    if (!config.authHeader && !config.password)
      throw new SlackPolicyError("daemon_authentication_required");
    this.driver = new DaemonClient({
      ...config,
      clientId: "savage-slack-bridge",
      connectTimeoutMs: 10_000,
      reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 30_000 },
    });
    this.api = createPaseoApi(this.driver);
  }

  async connect(): Promise<void> {
    await this.driver.connect();
    this.requireIdentity();
  }

  private requireIdentity(): void {
    const info = this.driver.getLastServerInfoMessage();
    if (!info || info.serverId !== this.config.serverId)
      throw new SlackPolicyError("daemon_identity");
    if (info.features?.agentRequestReceipts !== true)
      throw new SlackStateError("Update Paseo: durable request receipts are required");
  }

  async verifyTarget(target: SlackTarget): Promise<void> {
    this.requireIdentity();
    if (target.serverId !== this.config.serverId) throw new SlackPolicyError("target_host");
    const catalog = await this.api.projects.list();
    const project = catalog.projects.find((entry) => entry.projectId === target.projectId);
    if (!project || project.projectRootPath !== target.cwd)
      throw new SlackPolicyError("project_catalog");
  }

  async create(intake: SlackIntake, target: SlackTarget): Promise<PaseoAgentHandle> {
    await this.verifyTarget(target);
    // Creation never starts work; the durable identity must be bound before dispatch.
    return this.api.agents.create({
      idempotencyKey: stableOperationId("create", intake.conversationKey),
      cwd: target.cwd,
      config: this.config.agentConfig,
      title: `Slack ${intake.channelId} / ${intake.rootTs}`,
      labels: {
        slackOwner: intake.userId,
        slackConversation: stableOperationId("binding", intake.conversationKey),
      },
    });
  }

  async inspect(binding: SlackBinding): Promise<PaseoAgentHandle> {
    await this.verifyTarget(binding.target);
    const agent = this.api.agents.ref(binding.agentId);
    const snapshot = await agent.refresh();
    if (!snapshot) throw new SlackStateError("The bound Paseo session is unavailable");
    if (agent.archivedAt)
      throw new SlackStateError(
        "The bound Paseo session is archived; restore it in Paseo before continuing",
      );
    const workspace = this.api.workspaces.ref(binding.workspaceId);
    await workspace.refresh();
    if (
      agent.workspaceId !== binding.workspaceId ||
      workspace.projectId !== binding.target.projectId
    ) {
      throw new SlackPolicyError("session_moved");
    }
    return agent;
  }

  async send(agent: PaseoAgentHandle, intake: SlackIntake): Promise<void> {
    this.requireIdentity();
    if (agent.activeTurn)
      throw new SlackStateError("Session is busy; accepted message remains queued");
    await agent.send(intake.text, { messageId: stableOperationId("message", intake.id) });
  }

  async close(): Promise<void> {
    try {
      await this.api.dispose();
    } finally {
      await this.driver.close();
    }
  }
}
