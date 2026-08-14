import type {
  ConversationDetailResponse,
  ConversationListResponse,
  ConversationSummary,
  SessionResponse,
} from "@capstone/protocol";
import { type InfiniteData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../copy";
import { conversationQueryKeys } from "./api";
import { SIDEBAR_COLLAPSED_STORAGE_KEY } from "./config";
import { ConversationShell } from "./conversation-shell";
import { DraftMemoryProvider } from "./draft-memory";

const conversationId = "11111111-1111-4111-8111-111111111111";
const otherConversationId = "22222222-2222-4222-8222-222222222222";
const session = {
  employee: { id: "employee-1", name: "Ana", email: "ana@example.test" },
  workspace: {
    id: "workspace-1",
    identity: "capstone",
    name: "Capstone",
    role: "member",
  },
  session: {
    createdAt: "2026-08-14T12:00:00.000Z",
    expiresAt: "2026-08-21T12:00:00.000Z",
  },
} satisfies SessionResponse;
const queryScope = [session.workspace.id, session.employee.id, session.session.createdAt] as const;

function summary(id: string, title: string | null, isArchived = false): ConversationSummary {
  return {
    id,
    title,
    isArchived,
    revision: 3,
    createdAt: "2026-08-14T12:00:00.000Z",
    updatedAt: "2026-08-14T12:03:00.000Z",
  };
}

function detail(conversation: ConversationSummary): ConversationDetailResponse {
  return {
    conversation,
    messages: [],
    nextCursor: null,
    selectedLeafId: null,
  };
}

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((media: string) => ({
      matches,
      media,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function stubLocalStorage(collapsed: boolean): void {
  const values = new Map<string, string>(
    collapsed ? [[SIDEBAR_COLLAPSED_STORAGE_KEY, "true"]] : [],
  );
  vi.stubGlobal("localStorage", {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  } satisfies Storage);
}

function renderShell({
  collapsed = false,
  current,
  history = [],
  mobile = false,
  seedDetail = true,
}: {
  readonly collapsed?: boolean;
  readonly current: ConversationSummary;
  readonly history?: readonly ConversationSummary[];
  readonly mobile?: boolean;
  readonly seedDetail?: boolean;
}) {
  stubMatchMedia(mobile);
  stubLocalStorage(collapsed);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  if (seedDetail) {
    queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
      conversationQueryKeys.detail(queryScope, current.id),
      { pages: [detail(current)], pageParams: [undefined] },
    );
  }
  queryClient.setQueryData<InfiniteData<ConversationListResponse>>(
    conversationQueryKeys.history(queryScope, "active"),
    {
      pages: [{ conversations: [...history], nextCursor: null }],
      pageParams: [undefined],
    },
  );
  queryClient.setQueryData(["readiness"], { status: "ready" });

  function SessionLayout() {
    return <Outlet context={session} />;
  }

  function DraftLayout() {
    return (
      <DraftMemoryProvider queryScope={queryScope}>
        <ConversationShell />
      </DraftMemoryProvider>
    );
  }

  const router = createMemoryRouter(
    [
      {
        Component: SessionLayout,
        children: [
          {
            Component: DraftLayout,
            children: [
              {
                path: "/c/:conversationId",
                element: <p data-testid="conversation-route">Contenido</p>,
              },
            ],
          },
        ],
      },
    ],
    { initialEntries: [`/c/${current.id}`] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { queryClient, router };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("conversation shell", () => {
  it("pins an untitled archived current conversation above Recent", () => {
    const current = summary(conversationId, null, true);
    renderShell({ current, history: [current] });

    const desktop = document.querySelector<HTMLElement>(".desktop-sidebar");
    expect(desktop).not.toBeNull();
    const pinned = within(desktop as HTMLElement).getByText(
      copy.conversations.navigation.current,
    ).parentElement;
    expect(pinned).not.toBeNull();
    expect(
      within(pinned as HTMLElement).getByRole("link", {
        name: `${copy.conversations.common.untitled}, ${copy.conversations.conversation.archivedState}`,
      }),
    ).toHaveAttribute("href", `/c/${conversationId}`);
    expect(
      within(pinned as HTMLElement).getByText(copy.conversations.conversation.archivedState),
    ).toBeVisible();
    expect(
      within(desktop as HTMLElement).getByRole("heading", {
        name: copy.conversations.navigation.recent,
      }),
    ).toBeVisible();
    expect(within(desktop as HTMLElement).getByText(copy.conversations.common.empty)).toBeVisible();
    expect(within(desktop as HTMLElement).queryByRole("list")).not.toBeInTheDocument();
  });

  it("preserves a long decomposed Unicode title while excluding only its current ID", () => {
    const title = `${"Árbol 👩🏽‍💻 cafe\u0301 — ".repeat(8)}final`;
    const current = summary(conversationId, title);
    const sameTitle = summary(otherConversationId, title);
    renderShell({ current, history: [current, sameTitle] });

    const desktop = document.querySelector<HTMLElement>(".desktop-sidebar");
    expect(desktop).not.toBeNull();
    const pinnedLink = within(desktop as HTMLElement).getAllByTitle(title)[0];
    expect(pinnedLink).toHaveClass("current-conversation-link");
    expect(pinnedLink).not.toHaveClass("history-link");
    expect(pinnedLink).toHaveAttribute("href", `/c/${conversationId}`);
    expect(pinnedLink).toHaveAttribute("title", title);
    const historyList = within(desktop as HTMLElement).getByRole("list");
    expect(within(historyList).getAllByRole("link", { name: title })).toHaveLength(1);
    expect(within(historyList).getByRole("link", { name: title })).toHaveAttribute(
      "href",
      `/c/${otherConversationId}`,
    );
  });

  it.each([
    ["expanded desktop", false, false, ".desktop-sidebar .conversation-action-disclosure"],
    ["collapsed desktop", false, true, ".conversation-context-strip"],
    ["mobile", true, false, ".mobile-conversation-header .conversation-action-disclosure"],
  ])(
    "mounts one disclosure and one dialog set on %s",
    (_name, mobile, collapsed, expectedSurface) => {
      const current = summary(conversationId, "Conversación actual");
      renderShell({ collapsed, current, mobile });

      expect(document.querySelector(expectedSurface)).not.toBeNull();
      expect(document.querySelectorAll(".conversation-action-disclosure")).toHaveLength(1);
      expect(document.querySelectorAll(".action-dialog")).toHaveLength(2);
      expect(
        screen.getAllByRole("button", {
          name: copy.conversations.conversation.actionsLabel(current.title ?? ""),
        }),
      ).toHaveLength(1);
      const ids = [...document.querySelectorAll<HTMLElement>("[id]")].map((element) => element.id);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );

  it.each([
    ["expanded desktop", false, false, ".desktop-sidebar .current-conversation-placeholder"],
    [
      "collapsed desktop",
      false,
      true,
      ".conversation-context-strip .current-conversation-placeholder",
    ],
    ["mobile", true, false, ".mobile-conversation-header .current-conversation-placeholder"],
  ])(
    "reserves the current title and action slots while %s detail loads",
    (_name, mobile, collapsed, selector) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => new Promise<Response>(() => undefined)),
      );
      const current = summary(conversationId, "Conversación que carga");
      renderShell({ collapsed, current, mobile, seedDetail: false });

      const placeholder = document.querySelector<HTMLElement>(selector);
      expect(placeholder).not.toBeNull();
      expect(placeholder).toHaveAttribute("aria-hidden", "true");
      expect(
        placeholder?.parentElement?.querySelector(".conversation-action-placeholder"),
      ).not.toBeNull();
      expect(document.querySelectorAll(".conversation-action-disclosure")).toHaveLength(0);

      if (mobile) {
        expect(document.querySelector(".mobile-conversation-header img")).toBeNull();
      }
    },
  );

  it("excludes the routed conversation from Recientes while its detail is still loading", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    const current = summary(conversationId, "Conversación que carga");
    const other = summary(otherConversationId, "Otra conversación");
    renderShell({ current, history: [current, other], seedDetail: false });

    const desktop = document.querySelector<HTMLElement>(".desktop-sidebar");
    expect(desktop).not.toBeNull();
    // The pinned placeholder reserves the slot; the same conversation must not
    // simultaneously render as an ordinary history link.
    expect(document.querySelector(".current-conversation-placeholder")).not.toBeNull();
    const historyList = within(desktop as HTMLElement).getByRole("list");
    expect(
      within(historyList).queryByRole("link", { name: current.title ?? "" }),
    ).not.toBeInTheDocument();
    expect(within(historyList).getByRole("link", { name: other.title ?? "" })).toHaveAttribute(
      "href",
      `/c/${otherConversationId}`,
    );
  });

  it("keeps focus on the collapse control when collapsing with the action panel open", async () => {
    const user = userEvent.setup();
    const current = summary(conversationId, "Conversación actual");
    renderShell({ current });

    await user.click(
      screen.getByRole("button", {
        name: copy.conversations.conversation.actionsLabel(current.title ?? ""),
      }),
    );
    expect(
      screen.getByRole("button", { name: copy.conversations.conversation.rename }),
    ).toBeVisible();

    const collapseButton = screen.getByRole("button", {
      name: copy.conversations.navigation.collapse,
    });
    collapseButton.focus();
    await user.keyboard("{Enter}");

    // The context-strip disclosure mounts on collapse; it must not steal the
    // focus away from the control the user just activated.
    expect(document.querySelector(".conversation-context-strip")).not.toBeNull();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: copy.conversations.navigation.expand }),
      ).toBeVisible(),
    );
    await Promise.resolve();
    expect(
      screen.getByRole("button", { name: copy.conversations.navigation.expand }),
    ).toHaveFocus();
  });
});
