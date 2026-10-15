import { WebSocket } from "ws";
import { createHash } from "node:crypto";
import {
  createPaseoApi,
  type PaseoAgentConfig,
  type PaseoAgentHandle,
  type PaseoAgentRespondToPermissionOptions,
} from "@getpaseo/client";
import { DaemonClient, type DaemonClientConfig } from "@getpaseo/client/internal/daemon-client";
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

/** Accept only an explicit HTTP auth denial or Paseo's documented 4401 close. */
async function requireAnonymousRejection(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { handshakeTimeout: 5000 });
    let settled = false;
    const timer = setTimeout(() => finish(false), 5000);
    function finish(denied: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      if (denied) resolve();
      else reject(new SlackPolicyError("daemon_authentication_not_enforced"));
    }
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      finish(response.statusCode === 401 || response.statusCode === 403);
    });
    socket.on("error", () => finish(false));
    socket.on("close", (code) => finish(code === 4401));
  });
}

/** Owns one authenticated private daemon connection, separate from its agent runtime. */
export class SlackDaemon {
  private driver: DaemonClient;
  private authenticatedInfo: ReturnType<DaemonClient["getLastServerInfoMessage"]> = null;
  private readonly api;

  constructor(
    private config: SlackHostConfig,
    webSocketFactory?: DaemonClientConfig["webSocketFactory"],
  ) {
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
      webSocketFactory,
      // Only the bridge's fixed event codes and hashed correlations enter operational logs.
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      clientId: "savage-slack-bridge",
      connectTimeoutMs: 10_000,
      reconnect: { enabled: true, baseDelayMs: 1000, maxDelayMs: 30_000 },
    });
    this.api = createPaseoApi(this.driver);
  }

  async connect(): Promise<void> {
    await this.driver.connect();
    this.requireIdentity(false);
    const info = this.driver.getLastServerInfoMessage();
    if (this.authenticatedInfo !== info) {
      this.authenticatedInfo = null;
      await requireAnonymousRejection(this.config.url);
      this.authenticatedInfo = info;
    }
  }

  private requireIdentity(requireAuthentication = true): void {
    const info = this.driver.getLastServerInfoMessage();
    if (!info) throw new Error("Paseo connection temporarily unavailable");
    if (info.serverId !== this.config.serverId) throw new SlackPolicyError("daemon_identity");
    if (requireAuthentication && this.authenticatedInfo !== info)
      throw new Error("Paseo authentication verification pending");
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
    const separator = this.config.agentConfig.provider.indexOf("/");
    if (separator < 1) throw new SlackPolicyError("provider_model_format");
    const provider = this.config.agentConfig.provider.slice(0, separator);
    const model = this.config.agentConfig.provider.slice(separator + 1);
    const catalog = await this.api.providers.listModels(provider, { cwd: target.cwd });
    if (catalog.error || !catalog.models?.some((entry) => entry.id === model))
      throw new SlackStateError(
        "The configured provider/model is unavailable; operator review required",
      );
    // Creation never starts work; the durable identity must be bound before dispatch.
    const agent = await this.api.agents.create({
      idempotencyKey: stableOperationId("create", intake.conversationKey),
      cwd: target.cwd,
      config: this.config.agentConfig,
      title: `Slack ${intake.channelId} / ${intake.rootTs}`,
      labels: {
        slackOwner: intake.userId,
        slackConversation: stableOperationId("binding", intake.conversationKey),
        slackNativePermissions: "paseo-slack-v1",
      },
    });
    await agent.refresh();
    this.requireEligibleRoute(agent);
    return agent;
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

  private requireEligibleRoute(agent: PaseoAgentHandle): void {
    const snapshot = agent.current();
    if (!snapshot || `${snapshot.provider}/${snapshot.model}` !== this.config.agentConfig.provider)
      throw new SlackPolicyError("session_provider_model");
    if (
      this.config.agentConfig.modeId !== undefined &&
      snapshot.currentModeId !== this.config.agentConfig.modeId
    )
      throw new SlackPolicyError("session_permission_mode");
  }

  async send(input: { agent: PaseoAgentHandle; intake: SlackIntake; text: string }): Promise<void> {
    this.requireIdentity();
    await input.agent.refresh();
    this.requireEligibleRoute(input.agent);
    await input.agent.send(input.text, {
      messageId: stableOperationId("message", input.intake.id),
    });
  }

  async respond(
    agent: PaseoAgentHandle,
    response: PaseoAgentRespondToPermissionOptions,
  ): Promise<void> {
    this.requireIdentity();
    await agent.refresh();
    this.requireEligibleRoute(agent);
    await agent.respondToPermission(response);
  }

  async attach(input: { target: SlackTarget; agentId: string }): Promise<PaseoAgentHandle> {
    await this.verifyTarget(input.target);
    const agent = this.api.agents.ref(input.agentId);
    if (!(await agent.refresh()) || !agent.workspaceId || agent.archivedAt)
      throw new SlackStateError("Session is unavailable or archived");
    const workspace = this.api.workspaces.ref(agent.workspaceId);
    await workspace.refresh();
    if (workspace.projectId !== input.target.projectId)
      throw new SlackPolicyError("attachment_project");
    if (agent.activeTurn)
      throw new SlackStateError("Attach an idle session; current work will not be interrupted");
    this.requireEligibleRoute(agent);
    return agent;
  }

  async cancel(binding: SlackBinding): Promise<void> {
    await this.inspect(binding);
    await this.driver.cancelAgent(binding.agentId);
  }

  async close(): Promise<void> {
    try {
      await this.api.dispose();
    } finally {
      await this.driver.close();
    }
  }
}
