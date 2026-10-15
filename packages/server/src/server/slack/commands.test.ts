import { describe, expect, it } from "vitest";
import { parseSlackCommand, selectSlackTarget } from "./commands.js";
const targets = [
  { host: "local", project: "a", projectId: "p1", serverId: "s1", cwd: "/a" },
  { host: "local", project: "b", projectId: "p2", serverId: "s1", cwd: "/b" },
];
describe("Slack commands and target selection", () => {
  it("requires a choice for ambiguous targets and rejects unallowed choices", () => {
    expect(selectSlackTarget(targets, {})).toBeNull();
    expect(selectSlackTarget(targets, { host: "local", project: "b" })).toEqual(targets[1]);
    expect(() => selectSlackTarget(targets, { host: "other" })).toThrow("not allowed");
  });
  it("consumes only explicit leading selectors and preserves the task text", () => {
    expect(parseSlackCommand("host=local project=b remember violet")).toEqual({
      kind: "prompt",
      selection: { host: "local", project: "b" },
      text: "remember violet",
    });
    expect(parseSlackCommand("project=b")).toEqual({ kind: "select", selection: { project: "b" } });
    expect(() => parseSlackCommand("host=local host=other hello")).toThrow();
    expect(() => parseSlackCommand("project=../private hello")).toThrow();
  });
  it("requires explicit target-channel disclosure when attaching an existing session", () => {
    const id = "cb7c9a0c-46e2-40de-a0b9-f9211ddc5d50";
    expect(() => parseSlackCommand(`attach ${id}`)).toThrow("disclose=here");
    expect(parseSlackCommand(`attach ${id} disclose=here`)).toEqual({
      kind: "attach",
      agentId: id,
    });
  });
  it("ordinary approval text remains a prompt and cannot resolve a permission control", () => {
    expect(parseSlackCommand("approve")).toEqual({
      kind: "prompt",
      text: "approve",
      selection: {},
    });
    expect(parseSlackCommand("status")).toEqual({ kind: "status" });
    expect(parseSlackCommand("cancel")).toEqual({ kind: "cancel" });
  });
});
