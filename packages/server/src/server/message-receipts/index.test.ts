import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { MessageReceipts } from "./index.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-requests-"));
  directories.push(directory);
  return { directory, requests: new MessageReceipts(directory) };
}

test("message retries survive reconstruction without submitting twice", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: { text: "hello" },
    send: async () => {
      deliveries++;
    },
  };
  await Promise.all([requests.send(input), requests.send(input)]);
  await new MessageReceipts(directory).send(input);
  expect(deliveries).toBe(1);
  await requests.send({ ...input, agentId: "another" });
  expect(deliveries).toBe(2);
});

test("ambiguous provider delivery is never blindly replayed after restart", async () => {
  const { requests, directory } = await fixture();
  let deliveries = 0;
  const input = {
    agentId: "agent",
    messageId: "arrival",
    request: {},
    send: async () => {
      deliveries++;
      throw new Error("connection lost");
    },
  };
  await expect(requests.send(input)).rejects.toThrow("connection lost");
  await expect(new MessageReceipts(directory).send(input)).rejects.toThrow(
    "agent_request_outcome_unknown",
  );
  expect(deliveries).toBe(1);
});

test("failed local message preparation does not leave an ambiguous receipt", async () => {
  const { requests, directory } = await fixture();
  let available = false;
  let sends = 0;
  const input = {
    agentId: "agent",
    messageId: "message",
    request: {},
    prepare: async () => {
      if (!available) throw new Error("load failed");
    },
    send: async () => {
      sends++;
    },
  };
  await expect(requests.send(input)).rejects.toThrow("load failed");
  available = true;
  await new MessageReceipts(directory).send(input);
  available = false;
  await requests.send(input);
  expect(sends).toBe(1);
});

test("conditional admission keeps one accepted result across concurrent retries and reconstruction", async () => {
  const { requests, directory } = await fixture();
  let admissions = 0;
  const input = {
    agentId: "agent",
    messageId: "conditional-arrival",
    request: { text: "Review owned work" },
    admit: async () => {
      admissions++;
      return { status: "accepted" as const, turnId: "turn-1" };
    },
  };
  expect(await Promise.all([requests.admit(input), requests.admit(input)])).toEqual([
    { status: "accepted", turnId: "turn-1" },
    { status: "accepted", turnId: "turn-1" },
  ]);
  expect(await new MessageReceipts(directory).admit(input)).toEqual({
    status: "accepted",
    turnId: "turn-1",
  });
  expect(admissions).toBe(1);
});

test("conditional uncertainty survives restart without another provider attempt", async () => {
  const { requests, directory } = await fixture();
  let calls = 0;
  const input = {
    agentId: "recipient",
    messageId: "uncertain",
    request: { text: "owned task" },
    admit: async () => {
      calls++;
      throw new Error("Provider may have accepted before disconnect");
    },
  };
  expect(await requests.admit(input)).toEqual({ status: "outcome_unknown" });
  expect(await new MessageReceipts(directory).admit(input)).toEqual({ status: "outcome_unknown" });
  expect(calls).toBe(1);
});

test("conditional changed payload conflicts and a refusal does not become an eventual send", async () => {
  const { requests } = await fixture();
  let calls = 0;
  const input = {
    agentId: "recipient",
    messageId: "bounded",
    request: { text: "first" },
    admit: async () => {
      calls++;
      return { status: "rejected" as const, reason: "busy" as const };
    },
  };
  expect(await requests.admit(input)).toEqual({ status: "rejected", reason: "busy" });
  expect(await requests.admit({ ...input, request: { text: "changed" } })).toEqual({
    status: "rejected",
    reason: "message_id_conflict",
  });
  expect(await requests.admit(input)).toEqual({ status: "rejected", reason: "busy" });
  expect(calls).toBe(1);
});
