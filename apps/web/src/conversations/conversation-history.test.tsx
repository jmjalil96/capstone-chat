import type { ConversationListResponse, ConversationSummary } from "@capstone/protocol";
import { type InfiniteData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { copy } from "../copy";
import { conversationQueryKeys } from "./api";
import { ConversationHistory } from "./conversation-history";
import { DraftMemoryProvider } from "./draft-memory";

const queryScope = ["workspace-1", "employee-1", "2026-08-14T12:00:00.000Z"] as const;

function summary(id: string, title: string): ConversationSummary {
  return {
    id,
    title,
    isArchived: false,
    revision: 1,
    createdAt: "2026-08-14T12:00:00.000Z",
    updatedAt: "2026-08-14T12:00:00.000Z",
  };
}

afterEach(cleanup);

describe("conversation history", () => {
  it("excludes only the pinned conversation ID while retaining another conversation with the same title", () => {
    const current = summary("11111111-1111-4111-8111-111111111111", "Título compartido");
    const duplicateTitle = summary("22222222-2222-4222-8222-222222222222", current.title ?? "");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData<InfiniteData<ConversationListResponse>>(
      conversationQueryKeys.history(queryScope, "active"),
      {
        pages: [{ conversations: [current, duplicateTitle], nextCursor: null }],
        pageParams: [undefined],
      },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <DraftMemoryProvider queryScope={queryScope}>
          <MemoryRouter initialEntries={[`/c/${current.id}`]}>
            <ConversationHistory excludeConversationId={current.id} view="active" />
          </MemoryRouter>
        </DraftMemoryProvider>
      </QueryClientProvider>,
    );

    const list = screen.getByRole("list");
    expect(within(list).getAllByRole("link", { name: "Título compartido" })).toHaveLength(1);
    expect(within(list).queryByRole("link", { current: "page" })).not.toBeInTheDocument();
    expect(within(list).getByRole("link")).toHaveAttribute("href", `/c/${duplicateTitle.id}`);
  });

  it("shows the centralized empty state when exclusion removes the only recent conversation", () => {
    const current = summary("11111111-1111-4111-8111-111111111111", "Conversación actual");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData<InfiniteData<ConversationListResponse>>(
      conversationQueryKeys.history(queryScope, "active"),
      {
        pages: [{ conversations: [current], nextCursor: null }],
        pageParams: [undefined],
      },
    );

    render(
      <QueryClientProvider client={queryClient}>
        <DraftMemoryProvider queryScope={queryScope}>
          <MemoryRouter initialEntries={[`/c/${current.id}`]}>
            <ConversationHistory excludeConversationId={current.id} view="active" />
          </MemoryRouter>
        </DraftMemoryProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByText(copy.conversations.common.empty)).toBeVisible();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
