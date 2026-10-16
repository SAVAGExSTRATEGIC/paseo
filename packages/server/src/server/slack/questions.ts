import { z } from "zod";
import { SlackPolicyError, SlackStateError } from "./conversations.js";

const QuestionRequestSchema = z.object({
  kind: z.literal("question"),
  input: z.object({
    questions: z
      .array(
        z.object({
          header: z.string().min(1),
          question: z.string().min(1),
          options: z.array(z.object({ label: z.string() })).optional(),
          multiSelect: z.boolean().optional(),
          isSecret: z.boolean().optional(),
        }),
      )
      .min(1),
  }),
});

function questions(request: unknown) {
  const parsed = QuestionRequestSchema.safeParse(request);
  if (!parsed.success) throw new SlackStateError("Open Paseo to answer this question format");
  const result = parsed.data.input.questions;
  if (result.some((question) => question.isSecret))
    throw new SlackPolicyError("secret_question_requires_paseo");
  if (new Set(result.map((question) => question.header)).size !== result.length)
    throw new SlackStateError("Question headers are ambiguous; answer in Paseo");
  return result;
}

export function renderQuestion(request: unknown, token: string): string {
  const prompts = questions(request);
  const text = prompts
    .map((question) =>
      [
        `${question.header}: ${question.question}`,
        ...(question.options ?? []).map((option) => `- ${option.label}`),
        ...(question.multiSelect ? ["Separate multiple choices with commas."] : []),
      ].join("\n"),
    )
    .join("\n\n");
  const example =
    prompts.length === 1
      ? "your answer"
      : JSON.stringify(
          Object.fromEntries(prompts.map((question) => [question.header, "your answer"])),
        );
  return `${text}\n\nReply in this thread:\nanswer ${token} ${example}`;
}

/** Only explicit answers for a live question reach the provider's updatedInput contract. */
export function questionResponse(
  request: unknown,
  text: string,
): { behavior: "allow"; updatedInput: { answers: Record<string, string> } } {
  const prompts = questions(request);
  let answers: Record<string, string>;
  if (prompts.length === 1 && !text.trimStart().startsWith("{"))
    answers = { [prompts[0].header]: text.trim() };
  else {
    try {
      answers = z.record(z.string(), z.string().trim().min(1).max(20_000)).parse(JSON.parse(text));
    } catch {
      throw new SlackStateError("Answer each question using the JSON example in this thread");
    }
  }
  if (
    Object.keys(answers).length !== prompts.length ||
    prompts.some((question) => !answers[question.header]?.trim())
  )
    throw new SlackStateError("Answer every question using its exact header");
  return { behavior: "allow", updatedInput: { answers } };
}

/** Native Codex async replies create this additional user-message item in the same session. */
export function questionContinuation(
  request: unknown,
  response: ReturnType<typeof questionResponse>,
): string | undefined {
  const identity = z.object({ name: z.string() }).parse(request);
  if (identity.name !== "request_user_input_async") return undefined;
  return (
    "Answers to your questions:\n\n" +
    questions(request)
      .map((question) => `${question.question}\n${response.updatedInput.answers[question.header]}`)
      .join("\n\n")
  );
}
