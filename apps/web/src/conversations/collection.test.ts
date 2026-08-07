import type { ConversationDetailResponse, ConversationSummary } from "@capstone/protocol";
import { describe, expect, it } from "vitest";

import { orderedBranchMessages, uniqueConversations } from "./collection";

const summary = (id: string, title: string): ConversationSummary => ({
  id,
  title,
  isArchived: false,
  revision: 0,
  createdAt: "2026-08-06T12:00:00.000Z",
  updatedAt: "2026-08-06T12:00:00.000Z",
});

describe("conversation page merging", () => {
  it("keeps first-page order while removing conversations moved across pages", () => {
    const first = summary("11111111-1111-4111-8111-111111111111", "Primera");
    const second = summary("22222222-2222-4222-8222-222222222222", "Segunda");

    expect(
      uniqueConversations([
        { conversations: [first, second] },
        { conversations: [{ ...first, title: "Duplicada" }] },
      ]),
    ).toEqual([first, second]);
  });

  it("prepends older branch pages in reading order without duplicates", () => {
    const message = (id: string, text: string) => ({
      id,
      parentMessageId: null,
      role: "user" as const,
      content: [{ type: "text" as const, text }],
      createdAt: "2026-08-06T12:00:00.000Z",
      siblingCount: 0,
    });
    const recent = message("33333333-3333-4333-8333-333333333333", "Reciente");
    const current = {
      conversation: summary("11111111-1111-4111-8111-111111111111", "Conversación"),
      selectedLeafId: "33333333-3333-4333-8333-333333333333",
      messages: [recent],
      nextCursor: null,
    } satisfies ConversationDetailResponse;
    const older = {
      ...current,
      messages: [message("22222222-2222-4222-8222-222222222222", "Anterior"), recent],
    };

    expect(orderedBranchMessages([current, older]).map((item) => item.content[0]?.text)).toEqual([
      "Anterior",
      "Reciente",
    ]);
  });
});
