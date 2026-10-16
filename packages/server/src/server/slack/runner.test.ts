import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import { z } from "zod";
import { hashSync } from "bcryptjs";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { ConversationStore } from "./conversations.js";
import { SlackDaemon } from "./daemon.js";
import { ConversationRunner } from "./runner.js";
import type { BridgeConfig } from "./config.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function fixture(modeId = "full-access", withDisconnect = false) {
  let blocked = false;
  const connections: WebSocket[] = [];
  let dropNextTurn = false;
  const turns: string[] = [];
  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    auth: { password: hashSync("fixture-password", 4) },
    agentClients: createTestAgentClients({
      onStartTurn: (prompt) => {
        turns.push(String(prompt));
        if (dropNextTurn) {
          dropNextTurn = false;
          blocked = true;
          connections.at(-1)?.terminate();
        }
      },
    }),
  });
  cleanup.push(() => daemon.close());
  const driver = new DaemonClient({
    clientId: "slack-runner-test",
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    password: "fixture-password",
    reconnect: { enabled: false },
  });
  cleanup.push(() => driver.close());
  await driver.connect();
  const api = createPaseoApi(driver);
  cleanup.push(async () => {
    await api.dispose();
  });
  const cwd = await mkdtemp(join(tmpdir(), "slack-runner-project-"));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  await api.workspaces.open(cwd);
  const project = (await api.projects.list()).projects.find(
    (entry) => entry.projectRootPath === cwd,
  );
  if (!project) throw new Error("Fixture project missing");
  const serverId = daemon.daemon.getServerId();
  const target = {
    host: "fixture",
    project: "fixture",
    projectId: project.projectId,
    serverId,
    cwd,
  };
  const directory = await mkdtemp(join(tmpdir(), "slack-runner-journal-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config: BridgeConfig = {
    appId: "A1",
    botUserId: "U9",
    healthPort: 34672,
    dataDirectory: directory,
    policy: {
      teamId: "T1",
      channelIds: ["C1"],
      userIds: ["U1"],
      allowDMs: true,
      targets: [target],
    },
    hosts: [
      {
        name: "fixture",
        url: `ws://127.0.0.1:${daemon.port}/ws`,
        serverId,
        passwordEnv: "FIXTURE_PASSWORD",
        agentConfig: { provider: "codex/gpt-5.4-mini", modeId },
      },
    ],
  };
  const host = new SlackDaemon(
    { ...config.hosts[0], password: "fixture-password" },
    withDisconnect
      ? (url, options) => {
          const socket = new WebSocket(url, options?.protocols, {
            headers: options?.headers,
          });
          socket.on("open", () => {
            if (blocked) socket.terminate();
          });
          connections.push(socket);
          return socket as unknown as WebSocketLike;
        }
      : undefined,
  );
  cleanup.push(() => host.close());
  await host.connect();
  const store = await ConversationStore.open(directory, config.policy);
  return {
    driver,
    store,
    host,
    config,
    directory,
    cwd,
    turns,
    connections,
    dropOnNextTurn: () => {
      dropNextTurn = true;
    },
    allowReconnect: () => {
      blocked = false;
    },
  };
}

it("preserves one session and exactly one dispatch across duplicate intake and runner restart (controlled provider fixture)", async () => {
  const { store, host, config, directory, turns } = await fixture();
  const message = {
    id: "Ev1",
    teamId: "T1",
    userId: "U1",
    channelId: "C1",
    rootTs: "1.1",
    messageTs: "1.1",
    text: 'remember marker "violet-fixture"',
    isDM: false,
  };
  await store.accept(message);
  const firstController = new AbortController();
  const failures: string[] = [];
  const input = {
    config,
    hosts: new Map([["fixture", host]]),
    failure: (code: string) => {
      failures.push(code);
    },
  };
  const first = new ConversationRunner({
    ...input,
    store,
    signal: firstController.signal,
  });
  cleanup.push(async () => {
    firstController.abort();
    await first.close();
  });
  await first.tick();
  await expect
    .poll(
      () => ({
        pending: store.pending(),
        failures,
        turns,
        deliveries: store.deliveries(),
      }),
      {
        timeout: 10_000,
      },
    )
    .toMatchObject({ pending: [] });
  expect(turns).toEqual([message.text]);
  const agentId = store.bindings()[0].agentId;
  expect(store.deliveries().filter((entry) => entry.id.startsWith("slack-final-"))).toHaveLength(1);
  firstController.abort();
  await first.close();
  const recovered = await ConversationStore.open(directory, config.policy);
  expect(await recovered.accept(message)).toBe("duplicate");
  await recovered.accept({
    ...message,
    id: "Ev2",
    messageTs: "2.1",
    text: "What was the marker?",
  });
  const secondController = new AbortController();
  const second = new ConversationRunner({
    ...input,
    store: recovered,
    signal: secondController.signal,
  });
  cleanup.push(async () => {
    secondController.abort();
    await second.close();
  });
  await second.tick();
  await expect.poll(() => recovered.pending().length, { timeout: 20_000 }).toBe(0);
  expect(recovered.bindings()).toHaveLength(1);
  expect(recovered.bindings()[0].agentId).toBe(agentId);
  expect(turns).toEqual([message.text, "What was the marker?"]);
  expect(
    recovered.deliveries().findLast((entry) => entry.id.startsWith("slack-final-"))?.text,
  ).toContain("violet-fixture");
  secondController.abort();
  await second.close();
  await recovered.accept({
    ...message,
    id: "Ev3",
    messageTs: "3.1",
    text: "respond with exactly: recovered-once",
  });
  const agent = await host.inspect(recovered.bindings()[0]);
  const tail = await agent.timeline.refetch({
    limit: 1,
    projection: "canonical",
  });
  await recovered.prepareDispatch("Ev3", {
    epoch: tail.epoch,
    seq: tail.window.maxSeq,
  });
  const pending = recovered.pending().find((entry) => entry.id === "Ev3");
  if (!pending) throw new Error("Recovery fixture input missing");
  // Execution succeeds while the bridge journal still says dispatching: the acknowledgement was lost.
  await host.send({ agent, intake: pending, text: pending.text });
  await agent.waitForFinish();
  const afterLostAck = await ConversationStore.open(directory, config.policy);
  const thirdController = new AbortController();
  const third = new ConversationRunner({
    ...input,
    store: afterLostAck,
    signal: thirdController.signal,
  });
  cleanup.push(async () => {
    thirdController.abort();
    await third.close();
  });
  await third.tick();
  await expect.poll(() => afterLostAck.pending().length, { timeout: 10_000 }).toBe(0);
  expect(turns).toEqual([
    message.text,
    "What was the marker?",
    "respond with exactly: recovered-once",
  ]);
  expect(
    afterLostAck.deliveries().findLast((entry) => entry.id.startsWith("slack-final-"))?.text,
  ).toContain("recovered-once");
  expect(failures).toEqual([]);
}, 60_000);

it("holds a changed epoch for inspection and resumes its receipt without another dispatch", async () => {
  const { store, host, config, turns } = await fixture();
  const message = {
    id: "Ev-epoch",
    teamId: "T1",
    userId: "U1",
    channelId: "C1",
    rootTs: "1.1",
    messageTs: "1.1",
    text: "respond with exactly: epoch-once",
    isDM: false,
  };
  await store.accept(message);
  const event = store.pending()[0];
  const target = config.policy.targets[0];
  const agent = await host.create(event, target);
  if (!agent.workspaceId) throw new Error("Fixture workspace missing");
  await store.bind({
    key: event.conversationKey,
    ownerId: event.userId,
    target,
    agentId: agent.id,
    workspaceId: agent.workspaceId,
  });
  // The native receipt exists, but a provider reload invalidated the saved epoch.
  await store.prepareDispatch(event.id, {
    epoch: "superseded-provider-epoch",
    seq: 0,
  });
  await host.send({ agent, intake: store.pending()[0], text: message.text });
  await agent.waitForFinish();
  await store.transition(event.id, "dispatching", "running");
  const controller = new AbortController();
  const runner = new ConversationRunner({
    config,
    store,
    hosts: new Map([["fixture", host]]),
    signal: controller.signal,
    failure: () => {},
  });
  cleanup.push(async () => {
    controller.abort();
    await runner.close();
  });
  await runner.tick();
  await expect.poll(() => store.pending()[0]?.phase, { timeout: 10_000 }).toBe("needs_attention");
  expect(turns).toEqual([message.text]);
  expect(store.deliveries().some((entry) => entry.text.includes("operator reconciliation"))).toBe(
    true,
  );
  controller.abort();
  await runner.close();
  await store.resume(event.id);
  const recoveryController = new AbortController();
  const recovered = new ConversationRunner({
    config,
    store,
    hosts: new Map([["fixture", host]]),
    signal: recoveryController.signal,
    failure: () => {},
  });
  cleanup.push(async () => {
    recoveryController.abort();
    await recovered.close();
  });
  await recovered.tick();
  await expect.poll(() => store.pending().length, { timeout: 10_000 }).toBe(0);
  expect(turns).toEqual([message.text]);
  expect(store.deliveries().filter((entry) => entry.id.startsWith("slack-final-"))).toHaveLength(1);
  expect(store.deliveries().find((entry) => entry.id.startsWith("slack-final-"))?.text).toContain(
    "epoch-once",
  );
}, 45_000);

it("holds a real daemon permission until an authorized bound interaction, and denial prevents the fixture write", async () => {
  const { store, host, config, cwd } = await fixture("default");
  const controller = new AbortController();
  const failures: string[] = [];
  const runner = new ConversationRunner({
    config,
    store,
    hosts: new Map([["fixture", host]]),
    signal: controller.signal,
    failure: (code) => {
      failures.push(code);
    },
  });
  cleanup.push(async () => {
    controller.abort();
    await runner.close();
  });
  const message = {
    id: "Ev-permit",
    teamId: "T1",
    userId: "U1",
    channelId: "C1",
    rootTs: "1.1",
    messageTs: "1.1",
    text: 'create a file named "permission-result.txt" with the content "harmless"',
    isDM: false,
  };
  await store.accept(message);
  await runner.tick();
  await expect
    .poll(
      () =>
        store.deliveries().filter((entry) => entry.text.startsWith("Permission required:")).length,
      { timeout: 10_000 },
    )
    .toBe(1);
  await expect(readFile(join(cwd, "permission-result.txt"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  const delivery = store
    .deliveries()
    .find((entry) => entry.text.startsWith("Permission required:"));
  const actions = z
    .object({
      elements: z.array(z.object({ action_id: z.string(), value: z.string() })),
    })
    .parse(delivery?.blocks?.at(-1)).elements;
  const token = actions.find((entry) => entry.action_id === "paseo_allow")?.value;
  if (!token || !delivery) throw new Error("Fixture approval missing");
  await expect(
    store.acceptInteraction({
      id: "bad",
      token,
      key: delivery.key,
      actorId: "U2",
      behavior: "allow",
    }),
  ).rejects.toThrow();
  await store.acceptInteraction({
    id: "good",
    token,
    key: delivery.key,
    actorId: "U1",
    behavior: "allow",
  });
  await runner.tick();
  await expect.poll(() => store.pending().length, { timeout: 10_000 }).toBe(0);
  expect(await readFile(join(cwd, "permission-result.txt"), "utf8")).toBe("harmless");
  await store.accept({
    ...message,
    id: "Ev-deny",
    messageTs: "2.1",
    text: 'create a file named "denied-result.txt" with the content "blocked"',
  });
  await expect
    .poll(
      async () => {
        await runner.tick();
        return store.deliveries().filter((entry) => entry.text.startsWith("Permission required:"))
          .length;
      },
      { timeout: 10_000 },
    )
    .toBe(2);
  const denied = store
    .deliveries()
    .findLast((entry) => entry.text.startsWith("Permission required:"));
  const denyActions = z
    .object({
      elements: z.array(z.object({ action_id: z.string(), value: z.string() })),
    })
    .parse(denied?.blocks?.at(-1)).elements;
  const denyToken = denyActions.find((entry) => entry.action_id === "paseo_deny")?.value;
  if (!denyToken || !denied) throw new Error("Fixture denial missing");
  await store.acceptInteraction({
    id: "deny",
    token: denyToken,
    key: denied.key,
    actorId: "U1",
    behavior: "deny",
  });
  await runner.tick();
  await expect.poll(() => store.pending().length, { timeout: 10_000 }).toBe(0);
  await expect(readFile(join(cwd, "denied-result.txt"), "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(failures).toEqual([]);
}, 60_000);

it("rejects a daemon that accepts anonymous connections even when a password was supplied", async () => {
  const daemon = await createTestPaseoDaemon({ mcpEnabled: false });
  cleanup.push(() => daemon.close());
  const host = new SlackDaemon({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    serverId: daemon.daemon.getServerId(),
    password: "not-enforced",
    agentConfig: { provider: "codex/gpt-5.4-mini" },
  });
  cleanup.push(() => host.close());
  await expect(host.connect()).rejects.toMatchObject({
    code: "daemon_authentication_not_enforced",
  });
  await expect(
    host.verifyTarget({
      host: "fixture",
      project: "fixture",
      projectId: "p1",
      cwd: "/fixture",
      serverId: daemon.daemon.getServerId(),
    }),
  ).rejects.toThrow("verification pending");
}, 20_000);

it("verifies anonymous denial when the daemon requires hello before checking credentials", async () => {
  const daemon = await createTestPaseoDaemon({
    mcpEnabled: false,
    auth: { password: hashSync("fixture-password", 4) },
  });
  cleanup.push(() => daemon.close());
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const sockets = new Set<WebSocket>();
  let anonymousHellos = 0;
  cleanup.push(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.on("connection", (socket, request) => {
    sockets.add(socket);
    if (!request.headers["sec-websocket-protocol"]) {
      socket.on("message", (data) => {
        if (JSON.parse(data.toString()).type !== "hello") return;
        anonymousHellos++;
        socket.close(4401, "Password required");
      });
      return;
    }
    const upstream = new WebSocket(
      `ws://127.0.0.1:${daemon.port}/ws`,
      request.headers["sec-websocket-protocol"].split(",").map((value) => value.trim()),
    );
    sockets.add(upstream);
    const queued: string[] = [];
    socket.on("message", (data) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data.toString());
      else queued.push(data.toString());
    });
    upstream.on("open", () => {
      for (const data of queued.splice(0)) upstream.send(data);
    });
    upstream.on("message", (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data.toString());
    });
    upstream.on("error", () => socket.terminate());
    socket.on("close", () => upstream.terminate());
  });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture address missing");
  const host = new SlackDaemon({
    url: `ws://127.0.0.1:${address.port}/ws`,
    serverId: daemon.daemon.getServerId(),
    password: "fixture-password",
    agentConfig: { provider: "codex/gpt-5.4-mini" },
  });
  cleanup.push(() => host.close());
  await host.connect();
  expect(anonymousHellos).toBe(1);
}, 20_000);

it("recovers a real SDK network disconnect with retained work and one native dispatch", async () => {
  const { store, host, config, turns, connections, dropOnNextTurn, allowReconnect } = await fixture(
    "full-access",
    true,
  );
  const controller = new AbortController();
  expect(host.ready).toBe(true);
  const runner = new ConversationRunner({
    config,
    store,
    hosts: new Map([["fixture", host]]),
    signal: controller.signal,
    failure: () => {},
  });
  cleanup.push(async () => {
    controller.abort();
    allowReconnect();
    await runner.close();
  });
  await store.accept({
    id: "Ev-network",
    teamId: "T1",
    userId: "U1",
    channelId: "C1",
    rootTs: "1.1",
    messageTs: "1.1",
    text: "respond with exactly: reconnect-once",
    isDM: false,
  });
  dropOnNextTurn();
  await runner.tick();
  await expect
    .poll(
      () => store.deliveries().some((entry) => entry.text.includes("temporarily unavailable")),
      { timeout: 15_000 },
    )
    .toBe(true);
  expect(host.ready).toBe(false);
  allowReconnect();
  await host.connect();
  expect(host.ready).toBe(true);
  await expect.poll(() => store.pending().length, { timeout: 15_000 }).toBe(0);
  expect(connections.length).toBeGreaterThan(1);
  expect(turns).toEqual(["respond with exactly: reconnect-once"]);
  expect(store.bindings()).toHaveLength(1);
  expect(
    store.deliveries().findLast((entry) => entry.id.startsWith("slack-final-"))?.text,
  ).toContain("reconnect-once");
}, 45_000);

it("rejects attachment and dispatch outside the verified provider/model while retaining status and cancellation access", async () => {
  const { store, host, config, turns } = await fixture();
  const target = config.policy.targets[0];
  const message = {
    id: "route-check",
    teamId: "T1",
    userId: "U1",
    channelId: "C1",
    rootTs: "7.1",
    messageTs: "7.1",
    text: "must not dispatch",
    isDM: false,
  };
  await store.accept(message);
  const intake = store.pending()[0];
  const agent = await host.create(intake, target);
  if (!agent.workspaceId) throw new Error("Missing fixture workspace");
  await store.bind({
    key: intake.conversationKey,
    ownerId: "U1",
    target,
    agentId: agent.id,
    workspaceId: agent.workspaceId,
  });
  const binding = store.binding(intake.conversationKey);
  if (!binding) throw new Error("Missing fixture binding");
  expect((await host.attach({ target, agentId: agent.id })).id).toBe(agent.id);
  const otherRoute = new SlackDaemon({
    ...config.hosts[0],
    password: "fixture-password",
    agentConfig: {
      ...config.hosts[0].agentConfig,
      provider: "codex/unverified-model",
    },
  });
  cleanup.push(() => otherRoute.close());
  await otherRoute.connect();
  await expect(otherRoute.attach({ target, agentId: agent.id })).rejects.toThrow(
    "session_provider_model",
  );
  await expect(otherRoute.send({ agent, intake, text: message.text })).rejects.toThrow(
    "session_provider_model",
  );
  await expect(
    otherRoute.respond(agent, {
      requestId: "unverified-request",
      response: { behavior: "deny" },
    }),
  ).rejects.toThrow("session_provider_model");
  expect((await otherRoute.inspect(binding)).id).toBe(agent.id);
  await otherRoute.cancel(binding);
  expect(turns).toEqual([]);
});

it("rejects a native permission-mode override before creation recovery, attachment, dispatch or response", async () => {
  const { store, host, config, driver, turns } = await fixture("auto");
  await store.accept({
    id: "mode-check",
    teamId: "T1",
    userId: "U1",
    channelId: "C1",
    rootTs: "8.1",
    messageTs: "8.1",
    text: "must not bypass native permissions",
    isDM: false,
  });
  const intake = store.pending()[0];
  const target = config.policy.targets[0];
  const agent = await host.create(intake, target);
  expect(agent.current()?.currentModeId).toBe("auto");
  if (!agent.workspaceId) throw new Error("Missing fixture workspace");
  await store.bind({
    key: intake.conversationKey,
    ownerId: "U1",
    target,
    agentId: agent.id,
    workspaceId: agent.workspaceId,
  });
  const binding = store.binding(intake.conversationKey);
  if (!binding) throw new Error("Missing fixture binding");
  await driver.setAgentMode(agent.id, "full-access");
  await expect(host.create(intake, target)).rejects.toThrow("session_permission_mode");
  await expect(host.attach({ target, agentId: agent.id })).rejects.toThrow(
    "session_permission_mode",
  );
  await expect(host.send({ agent, intake, text: intake.text })).rejects.toThrow(
    "session_permission_mode",
  );
  await expect(
    host.respond(agent, {
      requestId: "mode-request",
      response: { behavior: "allow" },
    }),
  ).rejects.toThrow("session_permission_mode");
  expect((await host.inspect(binding)).id).toBe(agent.id);
  await host.cancel(binding);
  expect(turns).toEqual([]);
});
