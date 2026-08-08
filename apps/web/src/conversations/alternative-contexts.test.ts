import type { ConversationDetailResponse, ConversationMessage } from "@capstone/protocol";
import { describe, expect, it } from "vitest";

import { alternativeContextChunks } from "./alternative-contexts";

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function message(index: number, siblingCount = 1): ConversationMessage {
  return {
    content: [{ type: "text", text: `Message ${index}` }],
    createdAt: "2026-08-07T12:00:00.000Z",
    id: uuid(index),
    parentMessageId: index === 0 ? null : uuid(index - 1),
    role: index % 2 === 0 ? "user" : "assistant",
    siblingCount,
  };
}

function page(messages: ConversationMessage[]): ConversationDetailResponse {
  return {
    conversation: {
      createdAt: "2026-08-07T12:00:00.000Z",
      id: uuid(999),
      isArchived: false,
      revision: 4,
      title: "Fixture",
      updatedAt: "2026-08-07T12:00:00.000Z",
    },
    messages,
    nextCursor: null,
    selectedLeafId: messages.at(-1)?.id ?? null,
  };
}

describe("alternative context chunks", () => {
  it("keeps loaded detail pages in revision-bound request chunks of at most forty", () => {
    const first = Array.from({ length: 40 }, (_, index) => message(index));
    const second = Array.from({ length: 40 }, (_, index) => message(index + 40));

    const chunks = alternativeContextChunks([page(first), page(second)]);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(40);
    expect(chunks[1]).toHaveLength(40);
    expect(new Set(chunks.flat()).size).toBe(80);
  });

  it("omits messages without alternatives and deduplicates page boundaries", () => {
    const duplicate = message(2);
    const chunks = alternativeContextChunks([
      page([message(1, 0), duplicate]),
      page([duplicate, message(3)]),
    ]);

    expect(chunks).toEqual([[uuid(2)], [uuid(3)]]);
  });
});
