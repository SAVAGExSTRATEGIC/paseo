import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const TargetSchema = z.object({
  host: z.string().min(1),
  project: z.string().min(1),
  projectId: z.string().min(1),
  cwd: z.string().min(1),
  serverId: z.string().min(1),
});
export const SlackPolicySchema = z.object({
  teamId: z.string().min(1),
  userIds: z.array(z.string().min(1)).min(1),
  channelIds: z.array(z.string().startsWith("C")).min(1),
  allowDMs: z.boolean(),
  targets: z.array(TargetSchema).min(1),
});
export type SlackPolicy = z.infer<typeof SlackPolicySchema>;
export type SlackTarget = z.infer<typeof TargetSchema>;

const MessageSchema = z.object({
  id: z.string().min(1),
  teamId: z.string().min(1),
  userId: z.string().min(1),
  channelId: z.string().min(1),
  rootTs: z.string().regex(/^\d+\.\d+$/u),
  messageTs: z.string().regex(/^\d+\.\d+$/u),
  text: z.string().max(40_000),
  isDM: z.boolean(),
});
export type SlackMessage = z.infer<typeof MessageSchema>;
const PhaseSchema = z.enum(["accepted", "dispatching", "running", "needs_attention", "completed"]);
export type IntakePhase = z.infer<typeof PhaseSchema>;
const CursorSchema = z.object({ epoch: z.string(), seq: z.number().int().nonnegative() });
const IntakeSchema = MessageSchema.extend({
  conversationKey: z.string(),
  phase: PhaseSchema,
  receivedAt: z.number(),
  dispatchedAt: z.number().nullable().default(null),
  startCursor: CursorSchema.nullable().default(null),
  terminal: z.enum(["completed", "failed", "canceled"]).nullable().default(null),
});
export type SlackIntake = z.infer<typeof IntakeSchema>;
const BindingSchema = z.object({
  key: z.string(),
  ownerId: z.string(),
  target: TargetSchema,
  agentId: z.string(),
  workspaceId: z.string(),
  cursor: CursorSchema.nullable(),
  createdAt: z.number(),
});
export type SlackBinding = z.infer<typeof BindingSchema>;
const DeliverySchema = z.object({
  id: z.string(),
  key: z.string(),
  text: z.string(),
  phase: z.enum(["pending", "sending", "sent", "uncertain"]),
  slackTs: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  createdAt: z.number(),
});
export type SlackDelivery = z.infer<typeof DeliverySchema>;
const PermissionRequestSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string(),
    name: z.string(),
  })
  .passthrough();
const ControlSchema = z.object({
  token: z.string(),
  key: z.string(),
  agentId: z.string(),
  requestId: z.string(),
  fingerprint: z.string(),
  ownerId: z.string(),
  expiresAt: z.number(),
  phase: z.enum(["pending", "claimed", "resolved"]),
  behavior: z.enum(["allow", "deny"]).nullable(),
});
interface PermissionOffer {
  key: string;
  request: unknown;
  now: number;
}
interface PermissionClaim {
  token: string;
  key: string;
  actorId: string;
  behavior: "allow" | "deny";
  current: unknown;
  now: number;
}
interface ClaimedPermission {
  agentId: string;
  requestId: string;
  behavior: "allow" | "deny";
}

function permissionFingerprint(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const record = z.record(z.string(), z.unknown()).parse(item);
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });
  return createHash("sha256").update(canonical).digest("hex");
}

const StateSchema = z.object({
  version: z.literal(1),
  controls: z.array(ControlSchema).default([]),
  selections: z.array(z.object({ key: z.string(), target: TargetSchema })).default([]),
  bindings: z.array(BindingSchema),
  intake: z.array(IntakeSchema),
  outbox: z.array(DeliverySchema),
});
interface State extends z.infer<typeof StateSchema> {}
interface BindInput {
  key: string;
  ownerId: string;
  target: SlackTarget;
  agentId: string;
  workspaceId: string;
}
interface Output {
  id: string;
  text: string;
}
interface CheckpointInput {
  key: string;
  cursor: z.infer<typeof CursorSchema>;
  outputs: Output[];
}

export class SlackPolicyError extends Error {
  constructor(public readonly code: string) {
    super(`Slack policy rejected: ${code}`);
    this.name = "SlackPolicyError";
  }
}
export class SlackStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackStateError";
  }
}

export function conversationKey(
  message: Pick<SlackMessage, "teamId" | "channelId" | "rootTs">,
): string {
  return JSON.stringify([message.teamId, message.channelId, message.rootTs]);
}

export function authorizeMessage(policy: SlackPolicy, message: SlackMessage): void {
  if (message.teamId !== policy.teamId) throw new SlackPolicyError("workspace");
  if (!policy.userIds.includes(message.userId)) throw new SlackPolicyError("actor");
  if (message.isDM) {
    if (!policy.allowDMs || !message.channelId.startsWith("D")) throw new SlackPolicyError("dm");
  } else if (!policy.channelIds.includes(message.channelId)) {
    throw new SlackPolicyError("channel");
  }
}

function sameTarget(left: SlackTarget, right: SlackTarget): boolean {
  return (
    left.host === right.host &&
    left.projectId === right.projectId &&
    left.project === right.project &&
    left.serverId === right.serverId &&
    left.cwd === right.cwd
  );
}

async function writeState(directory: string, state: State): Promise<void> {
  const temporary = join(directory, `.conversations.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(state));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, join(directory, "conversations.json"));
    if (process.platform !== "win32") {
      const parent = await open(directory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

/** The process owns exclusive admission before opening this journal. */
export class ConversationStore {
  private tail: Promise<void> = Promise.resolve();
  private constructor(
    private directory: string,
    private policy: SlackPolicy,
    private state: State,
  ) {}

  static async open(directory: string, policy: SlackPolicy): Promise<ConversationStore> {
    const parsedPolicy = SlackPolicySchema.parse(policy);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
      throw new SlackStateError("Journal directory must be a real directory");
    if (process.platform !== "win32") {
      if (directoryInfo.uid !== process.getuid?.()) throw new SlackPolicyError("journal_owner");
      await chmod(directory, 0o700);
    }
    let state: State;
    try {
      const file = join(directory, "conversations.json");
      const fileInfo = await lstat(file);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink())
        throw new SlackStateError("Journal must be a regular file");
      if (process.platform !== "win32") {
        if (fileInfo.uid !== process.getuid?.()) throw new SlackPolicyError("journal_owner");
        await chmod(file, 0o600);
      }
      state = StateSchema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      state = { version: 1, controls: [], selections: [], bindings: [], intake: [], outbox: [] };
      await writeState(directory, state);
    }
    return new ConversationStore(directory, parsedPolicy, state);
  }

  private transaction<T>(update: (state: State) => T): Promise<T> {
    const result = this.commit(update);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async commit<T>(update: (state: State) => T): Promise<T> {
    await this.tail;
    const next = structuredClone(this.state);
    const value = update(next);
    await writeState(this.directory, next);
    this.state = next;
    return value;
  }

  async accept(input: SlackMessage): Promise<"accepted" | "duplicate"> {
    const message = MessageSchema.parse(input);
    authorizeMessage(this.policy, message);
    return this.transaction((state) => {
      const duplicate = state.intake.some(
        (event) =>
          event.id === message.id ||
          (event.teamId === message.teamId &&
            event.channelId === message.channelId &&
            event.messageTs === message.messageTs),
      );
      if (duplicate) return "duplicate";
      if (state.intake.length >= 10_000)
        throw new SlackStateError("Intake capacity reached; operator retention required");
      const key = conversationKey(message);
      const first = state.intake.find((entry) => entry.conversationKey === key);
      if (first && first.userId !== message.userId) throw new SlackPolicyError("binding_owner");
      const binding = state.bindings.find((entry) => entry.key === key);
      if (binding && binding.ownerId !== message.userId)
        throw new SlackPolicyError("binding_owner");
      state.intake.push({
        ...message,
        conversationKey: key,
        phase: "accepted",
        receivedAt: Date.now(),
        dispatchedAt: null,
        startCursor: null,
        terminal: null,
      });
      return "accepted";
    });
  }

  pending(): SlackIntake[] {
    return structuredClone(this.state.intake.filter((event) => event.phase !== "completed"));
  }
  binding(key: string): SlackBinding | undefined {
    return structuredClone(this.state.bindings.find((entry) => entry.key === key));
  }
  bindings(): SlackBinding[] {
    return structuredClone(this.state.bindings);
  }
  deliveries(): SlackDelivery[] {
    return structuredClone(this.state.outbox.filter((entry) => entry.phase !== "sent"));
  }

  bind(input: BindInput): Promise<void> {
    return this.transaction((state) => {
      if (!this.policy.userIds.includes(input.ownerId)) throw new SlackPolicyError("actor");
      if (!this.policy.targets.some((target) => sameTarget(target, input.target)))
        throw new SlackPolicyError("target");
      const intake = state.intake.find((event) => event.conversationKey === input.key);
      if (!intake) throw new SlackStateError("Cannot bind without authorized intake");
      authorizeMessage(this.policy, intake);
      if (intake.userId !== input.ownerId) throw new SlackPolicyError("binding_owner");
      const current = state.bindings.find((entry) => entry.key === input.key);
      if (current) {
        if (
          current.agentId === input.agentId &&
          current.workspaceId === input.workspaceId &&
          sameTarget(current.target, input.target)
        )
          return;
        throw new SlackStateError("Conversation already bound");
      }
      const reused = state.bindings.some(
        (entry) =>
          entry.target.serverId === input.target.serverId && entry.agentId === input.agentId,
      );
      if (reused) throw new SlackStateError("Session already attached to a conversation");
      state.bindings.push({ ...input, cursor: null, createdAt: Date.now() });
    });
  }

  transition(id: string, from: IntakePhase, to: IntakePhase): Promise<void> {
    return this.transaction((state) => {
      const event = state.intake.find((entry) => entry.id === id);
      if (!event || event.phase !== from) throw new SlackStateError("Intake state conflict");
      event.phase = to;
    });
  }

  checkpoint(input: CheckpointInput): Promise<void> {
    return this.transaction((state) => {
      const binding = state.bindings.find((entry) => entry.key === input.key);
      if (!binding) throw new SlackStateError("Unknown binding");
      for (const output of input.outputs) this.addOutput(state, input.key, output);
      binding.cursor = input.cursor;
    });
  }

  enqueue(key: string, output: Output): Promise<void> {
    return this.transaction((state) => {
      this.addOutput(state, key, output);
    });
  }

  private addOutput(state: State, key: string, output: Output): void {
    const existing = state.outbox.find((entry) => entry.id === output.id);
    if (existing) {
      if (existing.key !== key || existing.text !== output.text)
        throw new SlackStateError("Outbox identity conflict");
      return;
    }
    state.outbox.push({
      ...output,
      key,
      phase: "pending",
      slackTs: null,
      attempts: 0,
      createdAt: Date.now(),
    });
  }

  deliveryState(
    id: string,
    phase: SlackDelivery["phase"],
    slackTs: string | null = null,
  ): Promise<void> {
    return this.transaction((state) => {
      const entry = state.outbox.find((delivery) => delivery.id === id);
      if (!entry) throw new SlackStateError("Unknown delivery");
      entry.phase = phase;
      entry.slackTs = slackTs;
      if (phase === "sending") entry.attempts += 1;
    });
  }
  private requireAuthorizedBinding(state: State, key: string): SlackBinding {
    const binding = state.bindings.find((entry) => entry.key === key);
    if (!binding) throw new SlackStateError("Unknown binding");
    if (!this.policy.userIds.includes(binding.ownerId)) throw new SlackPolicyError("actor");
    if (!this.policy.targets.some((target) => sameTarget(target, binding.target)))
      throw new SlackPolicyError("target");
    const origin = state.intake.find((event) => event.conversationKey === key);
    if (!origin) throw new SlackStateError("Missing conversation origin");
    authorizeMessage(this.policy, origin);
    return binding;
  }

  async offerPermission(input: PermissionOffer): Promise<string> {
    const request = PermissionRequestSchema.parse(input.request);
    if (request.kind === "question")
      throw new SlackStateError("Question requires the user-input path");
    return this.transaction((state) => {
      const binding = this.requireAuthorizedBinding(state, input.key);
      const fingerprint = permissionFingerprint(request);
      const existing = state.controls.find(
        (control) =>
          control.key === input.key &&
          control.requestId === request.id &&
          control.fingerprint === fingerprint &&
          control.expiresAt > input.now,
      );
      if (existing) return existing.token;
      const token = randomUUID();
      state.controls.push({
        token,
        key: input.key,
        agentId: binding.agentId,
        requestId: request.id,
        fingerprint,
        ownerId: binding.ownerId,
        expiresAt: input.now + 10 * 60_000,
        phase: "pending",
        behavior: null,
      });
      return token;
    });
  }

  async claimPermission(input: PermissionClaim): Promise<ClaimedPermission> {
    const current = PermissionRequestSchema.parse(input.current);
    return this.transaction((state) => {
      const binding = this.requireAuthorizedBinding(state, input.key);
      const control = state.controls.find((entry) => entry.token === input.token);
      if (!control || control.key !== input.key || control.agentId !== binding.agentId)
        throw new SlackPolicyError("control_binding");
      if (control.ownerId !== input.actorId || !this.policy.userIds.includes(input.actorId))
        throw new SlackPolicyError("control_actor");
      if (control.expiresAt <= input.now) throw new SlackPolicyError("control_expired");
      if (
        control.requestId !== current.id ||
        control.fingerprint !== permissionFingerprint(current)
      )
        throw new SlackPolicyError("control_stale");
      if (control.phase !== "pending")
        throw new SlackStateError("Permission control already claimed");
      control.phase = "claimed";
      control.behavior = input.behavior;
      return { agentId: binding.agentId, requestId: current.id, behavior: input.behavior };
    });
  }
  selectedTarget(key: string): SlackTarget | null {
    return structuredClone(
      this.state.selections.find((selection) => selection.key === key)?.target ?? null,
    );
  }

  selectTarget(key: string, actorId: string, target: SlackTarget): Promise<void> {
    return this.transaction((state) => {
      const origin = state.intake.find((event) => event.conversationKey === key);
      if (!origin) throw new SlackStateError("Missing conversation origin");
      authorizeMessage(this.policy, origin);
      if (origin.userId !== actorId) throw new SlackPolicyError("binding_owner");
      if (!this.policy.targets.some((allowed) => sameTarget(allowed, target)))
        throw new SlackPolicyError("target");
      const binding = state.bindings.find((entry) => entry.key === key);
      if (binding && !sameTarget(binding.target, target))
        throw new SlackStateError("Start a new Slack thread to choose another target");
      const previous = state.selections.find((selection) => selection.key === key);
      if (previous) previous.target = target;
      else state.selections.push({ key, target });
    });
  }

  prepareDispatch(id: string, cursor: z.infer<typeof CursorSchema> | null): Promise<void> {
    return this.transaction((state) => {
      const event = state.intake.find((entry) => entry.id === id);
      if (!event || event.phase !== "accepted") throw new SlackStateError("Intake state conflict");
      authorizeMessage(this.policy, event);
      this.requireAuthorizedBinding(state, event.conversationKey);
      event.phase = "dispatching";
      event.dispatchedAt = Date.now();
      event.startCursor = cursor;
    });
  }

  recordTerminal(key: string, terminal: "completed" | "failed" | "canceled"): Promise<void> {
    return this.transaction((state) => {
      const event = state.intake.find(
        (entry) =>
          entry.conversationKey === key &&
          (entry.phase === "dispatching" || entry.phase === "running"),
      );
      if (event) event.terminal = terminal;
    });
  }

  finish(id: string, outputs: Output[]): Promise<void> {
    return this.transaction((state) => {
      const event = state.intake.find((entry) => entry.id === id);
      if (!event) throw new SlackStateError("Unknown intake");
      for (const output of outputs) this.addOutput(state, event.conversationKey, output);
      event.phase = "completed";
    });
  }

  knownConversation(key: string): boolean {
    return this.state.intake.some((event) => event.conversationKey === key);
  }
}
