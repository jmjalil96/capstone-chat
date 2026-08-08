import type { ConversationMessage } from "@capstone/protocol";
import { describe, expect, it } from "vitest";

import type { ChatRuntimeSnapshot } from "./chat-runtime";
import { branchPresentationMessages } from "./conversation-page";

function message(
  id: string,
  parentMessageId: string | null,
  role: ConversationMessage["role"],
): ConversationMessage {
  return {
    id,
    parentMessageId,
    role,
    content: [{ type: "text", text: id }],
    createdAt: "2026-08-07T12:00:00.000Z",
    siblingCount: 0,
  };
}

function snapshot(overrides: Partial<ChatRuntimeSnapshot>): ChatRuntimeSnapshot {
  return {
    awaitingCanonical: false,
    committedUserText: undefined,
    contextWarning: false,
    conversationId: "00000000-0000-4000-8000-000000000001",
    consumesDraft: false,
    errorCode: undefined,
    generationId: "00000000-0000-4000-8000-000000000002",
    locallyOwned: true,
    messageId: "00000000-0000-4000-8000-000000000099",
    phase: "generating",
    reason: undefined,
    recoveryRequired: false,
    revision: 5,
    text: "Nueva respuesta",
    userMessageId: "00000000-0000-4000-8000-000000000098",
    ...overrides,
  };
}

const firstUser = "00000000-0000-4000-8000-000000000010";
const firstAssistant = "00000000-0000-4000-8000-000000000011";
const secondUser = "00000000-0000-4000-8000-000000000012";
const secondAssistant = "00000000-0000-4000-8000-000000000013";
const thirdUser = "00000000-0000-4000-8000-000000000014";
const thirdAssistant = "00000000-0000-4000-8000-000000000015";
const canonical = [
  message(firstUser, null, "user"),
  message(firstAssistant, firstUser, "assistant"),
  message(secondUser, firstAssistant, "user"),
  message(secondAssistant, secondUser, "assistant"),
  message(thirdUser, secondAssistant, "user"),
  message(thirdAssistant, thirdUser, "assistant"),
];

describe("runtime branch presentation", () => {
  it("removes the old target and suffix while an edit branch is optimistic", () => {
    const presented = branchPresentationMessages(
      canonical,
      snapshot({
        branchAnchorMessageId: firstAssistant,
        requestSource: "edit",
        targetMessageId: secondUser,
      }),
    );

    expect(presented.map((item) => item.id)).toEqual([firstUser, firstAssistant]);
  });

  it("keeps the stored user but removes the old assistant and suffix for retry", () => {
    const presented = branchPresentationMessages(
      canonical,
      snapshot({
        branchAnchorMessageId: secondUser,
        requestSource: "retry",
        targetMessageId: secondAssistant,
      }),
    );

    expect(presented.map((item) => item.id)).toEqual([firstUser, firstAssistant, secondUser]);
  });

  it("returns the complete canonical branch once the runtime assistant is present", () => {
    const presented = branchPresentationMessages(
      canonical,
      snapshot({
        branchAnchorMessageId: secondUser,
        messageId: thirdAssistant,
        requestSource: "retry",
        targetMessageId: secondAssistant,
      }),
    );

    expect(presented).toEqual(canonical);
  });
});
