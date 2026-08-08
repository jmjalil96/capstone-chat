import {
  API_ERROR_CODES,
  ConversationSearchRequestSchema,
  SaveDraftRequestSchema,
  UserMessageContentSchema,
} from "@capstone/protocol";
import type { TSchema } from "typebox";
import Value from "typebox/value";

export type ContentValidationIssue = "invalid-text" | "too-large";

function validationIssue(schema: TSchema, value: unknown): ContentValidationIssue | undefined {
  if (Value.Check(schema, value)) {
    return undefined;
  }

  return Value.Errors(schema, value).some(
    (error) =>
      error.keyword === "~refine" && error.params.message === API_ERROR_CODES.PAYLOAD_TOO_LARGE,
  )
    ? "too-large"
    : "invalid-text";
}

export function draftContentValidationIssue(content: string): ContentValidationIssue | undefined {
  return validationIssue(SaveDraftRequestSchema, { content, observedRevision: 0 });
}

export function searchContentValidationIssue(query: string): ContentValidationIssue | undefined {
  if (query.trim().length === 0) {
    return undefined;
  }
  return validationIssue(ConversationSearchRequestSchema, { query });
}

export function userMessageContentValidationIssue(
  content: string,
): ContentValidationIssue | undefined {
  return validationIssue(UserMessageContentSchema, [{ type: "text", text: content }]);
}
