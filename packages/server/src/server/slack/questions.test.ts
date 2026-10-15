import { describe, expect, it } from "vitest";
import { questionResponse, renderQuestion } from "./questions.js";
import { parseSlackCommand } from "./commands.js";

const request = {
  kind: "question",
  input: {
    questions: [{ header: "Color", question: "Which color?", options: [{ label: "Violet" }] }],
  },
};
describe("Slack user-input contract", () => {
  it("renders a bound explicit answer and maps it to the native provider contract", () => {
    const token = "cb7c9a0c-46e2-40de-a0b9-f9211ddc5d50";
    expect(renderQuestion(request, token)).toContain(`answer ${token} your answer`);
    expect(parseSlackCommand(`answer ${token} Violet`)).toEqual({
      kind: "answer",
      token,
      text: "Violet",
    });
    expect(questionResponse(request, "Violet")).toEqual({
      behavior: "allow",
      updatedInput: { answers: { Color: "Violet" } },
    });
  });
  it("requires all exact headers for multiple questions without silently dropping an answer", () => {
    const multiple = {
      kind: "question",
      input: {
        questions: [...request.input.questions, { header: "Size", question: "Which size?" }],
      },
    };
    expect(() => questionResponse(multiple, "Violet")).toThrow("JSON");
    expect(() => questionResponse(multiple, '{"Color":"Violet"}')).toThrow("every question");
    expect(() =>
      questionResponse(multiple, '{"Color":"Violet","Size":"Large","Extra":"hidden"}'),
    ).toThrow();
    expect(
      questionResponse(multiple, '{"Color":"Violet","Size":"Large"}').updatedInput.answers,
    ).toEqual({ Color: "Violet", Size: "Large" });
  });
  it("refuses tool approvals and secret questions through the ordinary answer path", () => {
    expect(() => questionResponse({ ...request, kind: "tool" }, "yes")).toThrow();
    const secret = {
      kind: "question",
      input: { questions: [{ ...request.input.questions[0], isSecret: true }] },
    };
    expect(() => renderQuestion(secret, "token")).toThrow("secret_question");
    expect(() => questionResponse(secret, "secret")).toThrow("secret_question");
    expect(() => parseSlackCommand("answer random yes")).toThrow();
  });
});
