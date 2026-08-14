import type { ConversationDetailResponse, ConversationSummary } from "@capstone/protocol";
import { type InfiniteData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { createMemoryRouter, MemoryRouter, useLocation } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../copy";
import { conversationQueryKeys } from "./api";
import {
  ConversationActionDialogs,
  ConversationActionDisclosure,
} from "./conversation-action-controls";
import { useConversationActions } from "./conversation-actions";
import { useConversationDetail } from "./conversation-detail";
import { DraftMemoryProvider } from "./draft-memory";

const conversationId = "11111111-1111-4111-8111-111111111111";
const queryScope = ["workspace-1", "employee-1", "2026-08-14T12:00:00.000Z"] as const;
const conversation = {
  id: conversationId,
  title: "Conversación actual",
  isArchived: false,
  revision: 3,
  createdAt: "2026-08-14T12:00:00.000Z",
  updatedAt: "2026-08-14T12:00:00.000Z",
} satisfies ConversationSummary;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function detail(summary: ConversationSummary): ConversationDetailResponse {
  return {
    conversation: summary,
    messages: [],
    nextCursor: null,
    selectedLeafId: null,
  };
}

function ActionHarness({ current = conversation }: { readonly current?: ConversationSummary }) {
  const controller = useConversationActions(current);
  return (
    <>
      <ConversationActionDisclosure
        controller={controller}
        label={`Acciones de “${current.title}”`}
      />
      <ConversationActionDialogs controller={controller} />
      <details>
        <summary>Cuenta de prueba</summary>
      </details>
    </>
  );
}

function QueriedActionHarness() {
  const detailQuery = useConversationDetail(conversationId);
  const current = detailQuery.data?.pages[0]?.conversation;
  const controller = useConversationActions(current);
  return current ? (
    <>
      <ConversationActionDisclosure
        controller={controller}
        label={`Acciones de “${current.title}”`}
      />
      <ConversationActionDialogs controller={controller} />
    </>
  ) : null;
}

let switchActionSurface: (() => void) | undefined;

function HandoffHarness() {
  const [surface, setSurface] = useState("sidebar");
  switchActionSurface = () =>
    setSurface((current) => (current === "sidebar" ? "header" : "sidebar"));
  const controller = useConversationActions(conversation);
  return (
    <ConversationActionDisclosure
      key={surface}
      controller={controller}
      label={`Acciones ${surface}`}
    />
  );
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}:${String(location.state)}`}</output>;
}

function renderActions(
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  queryBacked = false,
) {
  const router = createMemoryRouter(
    [
      { path: "/", Component: LocationProbe },
      {
        path: "/c/:conversationId",
        element: queryBacked ? <QueriedActionHarness /> : <ActionHarness />,
      },
    ],
    { initialEntries: [`/c/${conversationId}`] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <DraftMemoryProvider queryScope={queryScope}>
        <RouterProvider router={router} />
      </DraftMemoryProvider>
    </QueryClientProvider>,
  );
  return { queryClient, router };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("conversation action disclosure", () => {
  it("uses an ordinary disclosure and restores trigger focus after Escape", async () => {
    const user = userEvent.setup();
    renderActions();

    const trigger = screen.getByRole("button", { name: `Acciones de “${conversation.title}”` });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger.querySelector("svg")).not.toBeNull();
    expect(trigger).not.toHaveTextContent("•••");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const panel = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
    expect(panel).not.toBeNull();
    expect(
      screen.getByRole("button", { name: copy.conversations.conversation.rename }),
    ).toHaveClass("conversation-action-row");
    expect(
      screen.getByRole("button", { name: copy.conversations.conversation.archive }),
    ).toHaveClass("conversation-action-row");
    expect(
      screen.getByRole("button", { name: copy.conversations.conversation.delete }),
    ).toHaveClass("conversation-action-row", "conversation-action-row-danger");

    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(trigger).toHaveFocus());

    await user.click(trigger);
    const accountSummary = screen.getByText("Cuenta de prueba");
    await user.click(accountSummary);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(accountSummary).toHaveFocus();
  });

  it("hands focus to the replacement trigger when the responsive surface changes", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={queryClient}>
        <DraftMemoryProvider queryScope={queryScope}>
          <MemoryRouter>
            <HandoffHarness />
          </MemoryRouter>
        </DraftMemoryProvider>
      </QueryClientProvider>,
    );

    const sidebarTrigger = screen.getByRole("button", { name: "Acciones sidebar" });
    await user.click(sidebarTrigger);
    await act(async () => switchActionSurface?.());

    const headerTrigger = screen.getByRole("button", { name: "Acciones header" });
    await waitFor(() => expect(headerTrigger).toHaveFocus());
    expect(headerTrigger).toHaveAttribute("aria-expanded", "false");
  });

  it("publishes rename and restores focus without waiting for ancillary refetches", async () => {
    const renamed = {
      ...conversation,
      title: "Nombre actualizado",
      revision: 4,
      updatedAt: "2026-08-14T12:01:00.000Z",
    } satisfies ConversationSummary;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(`/api/conversations/${conversationId}/title`)) {
        return json(renamed);
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    vi.spyOn(queryClient, "invalidateQueries").mockReturnValue(new Promise<void>(() => undefined));
    queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
      conversationQueryKeys.detail(queryScope, conversationId),
      { pages: [detail(conversation)], pageParams: [undefined] },
    );
    const user = userEvent.setup();
    renderActions(queryClient);

    const trigger = screen.getByRole("button", { name: `Acciones de “${conversation.title}”` });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.rename }));
    const input = screen.getByRole("textbox", {
      name: copy.conversations.conversation.titleLabel,
    });
    await user.clear(input);
    await user.type(input, renamed.title);
    await user.click(
      screen.getByRole("button", { name: copy.conversations.conversation.saveTitle }),
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/conversations/${conversationId}/title`,
        expect.objectContaining({
          body: JSON.stringify({ title: renamed.title, observedRevision: conversation.revision }),
          method: "PATCH",
        }),
      ),
    );
    await waitFor(() => {
      const cached = queryClient.getQueryData<InfiniteData<ConversationDetailResponse>>(
        conversationQueryKeys.detail(queryScope, conversationId),
      );
      expect(cached?.pages[0]?.conversation).toEqual(renamed);
    });
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("validates rename input, fences a pending save, reports failure in the dialog, and restores focus", async () => {
    let finishRename: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith(`/api/conversations/${conversationId}/title`)) {
          return new Promise<Response>((resolve) => {
            finishRename = resolve;
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    renderActions();

    const trigger = screen.getByRole("button", {
      name: `Acciones de “${conversation.title}”`,
    });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.rename }));
    const input = screen.getByRole("textbox", {
      name: copy.conversations.conversation.titleLabel,
    });
    const save = screen.getByRole("button", {
      name: copy.conversations.conversation.saveTitle,
    });

    await user.clear(input);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(save).toBeDisabled();

    await user.type(input, "Nombre válido");
    expect(input).toHaveAttribute("aria-invalid", "false");
    await user.click(save);
    expect(save).toBeDisabled();

    await act(async () => {
      finishRename?.(
        json(
          { code: "INTERNAL_ERROR", message: "Internal error", requestId: "request-rename" },
          500,
        ),
      );
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      copy.conversations.common.genericError,
    );
    expect(input).toHaveValue("Nombre válido");

    input.focus();
    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.cancel }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("archives and unarchives canonically while fencing duplicate actions and restoring focus", async () => {
    const archived = {
      ...conversation,
      isArchived: true,
      revision: 4,
      updatedAt: "2026-08-14T12:01:00.000Z",
    } satisfies ConversationSummary;
    const unarchived = {
      ...archived,
      isArchived: false,
      revision: 5,
      updatedAt: "2026-08-14T12:02:00.000Z",
    } satisfies ConversationSummary;
    let finishArchive: ((response: Response) => void) | undefined;
    let finishUnarchive: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith(`/api/conversations/${conversationId}/archive`)) {
          return new Promise<Response>((resolve) => {
            finishArchive = resolve;
          });
        }
        if (url.endsWith(`/api/conversations/${conversationId}/unarchive`)) {
          return new Promise<Response>((resolve) => {
            finishUnarchive = resolve;
          });
        }
        throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
      conversationQueryKeys.detail(queryScope, conversationId),
      { pages: [detail(conversation)], pageParams: [undefined] },
    );
    const user = userEvent.setup();
    renderActions(queryClient, true);

    let trigger = screen.getByRole("button", { name: `Acciones de “${conversation.title}”` });
    await user.click(trigger);
    const archive = screen.getByRole("button", {
      name: copy.conversations.conversation.archive,
    });
    await user.click(archive);
    expect(archive).toBeDisabled();
    expect(
      screen.getByRole("button", { name: copy.conversations.conversation.rename }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: copy.conversations.conversation.delete }),
    ).toBeDisabled();

    await act(async () => finishArchive?.(json(archived)));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/conversations/${conversationId}/archive`,
      expect.objectContaining({
        body: JSON.stringify({ observedRevision: conversation.revision }),
        method: "POST",
      }),
    );

    trigger = screen.getByRole("button", { name: `Acciones de “${conversation.title}”` });
    await user.click(trigger);
    const unarchive = screen.getByRole("button", {
      name: copy.conversations.conversation.unarchive,
    });
    await user.click(unarchive);
    expect(unarchive).toBeDisabled();

    await act(async () => finishUnarchive?.(json(unarchived)));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/conversations/${conversationId}/unarchive`,
      expect.objectContaining({
        body: JSON.stringify({ observedRevision: archived.revision }),
        method: "POST",
      }),
    );
    const cached = queryClient.getQueryData<InfiniteData<ConversationDetailResponse>>(
      conversationQueryKeys.detail(queryScope, conversationId),
    );
    expect(cached?.pages[0]?.conversation).toEqual(unarchived);
  });

  it("keeps a generic archive failure in the disclosure and focuses its retry alert", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith(`/api/conversations/${conversationId}/archive`)) {
          return json(
            { code: "INTERNAL_ERROR", message: "Internal error", requestId: "request-archive" },
            500,
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    renderActions();

    await user.click(screen.getByRole("button", { name: `Acciones de “${conversation.title}”` }));
    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.archive }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(copy.conversations.common.genericError);
    expect(alert).toHaveFocus();
    expect(screen.getByRole("button", { name: copy.conversations.common.retry })).toBeEnabled();
  });

  it("adopts canonical state and focuses a local retry alert after a stale archive", async () => {
    const canonical = {
      ...conversation,
      revision: 4,
      updatedAt: "2026-08-14T12:01:00.000Z",
    } satisfies ConversationSummary;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(`/api/conversations/${conversationId}/archive`)) {
        return json(
          {
            code: "CONVERSATION_CHANGED",
            message: "Conversation changed",
            requestId: "request-stale",
          },
          409,
        );
      }
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        return json(detail(canonical));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
      conversationQueryKeys.detail(queryScope, conversationId),
      { pages: [detail(conversation)], pageParams: [undefined] },
    );
    const user = userEvent.setup();
    renderActions(queryClient);

    await user.click(screen.getByRole("button", { name: `Acciones de “${conversation.title}”` }));
    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.archive }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(copy.conversations.common.changed);
    expect(alert).toHaveFocus();
    expect(screen.getByRole("button", { name: copy.conversations.common.retry })).toBeEnabled();
    const cached = queryClient.getQueryData<InfiniteData<ConversationDetailResponse>>(
      conversationQueryKeys.detail(queryScope, conversationId),
    );
    expect(cached?.pages[0]?.conversation).toEqual(canonical);
  });

  it("treats a retried archive as satisfied when canonical already matches", async () => {
    const canonical = {
      ...conversation,
      isArchived: true,
      revision: 4,
      updatedAt: "2026-08-14T12:01:00.000Z",
    } satisfies ConversationSummary;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(`/api/conversations/${conversationId}/archive`)) {
        return json(
          {
            code: "CONVERSATION_CHANGED",
            message: "Conversation changed",
            requestId: "request-stale",
          },
          409,
        );
      }
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        return json(detail(canonical));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
      conversationQueryKeys.detail(queryScope, conversationId),
      { pages: [detail(conversation)], pageParams: [undefined] },
    );
    const user = userEvent.setup();
    renderActions(queryClient, true);

    const trigger = screen.getByRole("button", { name: `Acciones de “${conversation.title}”` });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.archive }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(copy.conversations.common.changed);
    const requestsBeforeRetry = fetchMock.mock.calls.length;
    await user.click(screen.getByRole("button", { name: copy.conversations.common.retry }));

    // The other session already archived it: retrying must not unarchive.
    expect(fetchMock.mock.calls.length).toBe(requestsBeforeRetry);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/unarchive"))).toBe(
      false,
    );
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("replays the intended archive direction after adopting a changed canonical revision", async () => {
    const canonical = {
      ...conversation,
      title: "Título renombrado en otra pestaña",
      revision: 4,
      updatedAt: "2026-08-14T12:01:00.000Z",
    } satisfies ConversationSummary;
    const archiveBodies: unknown[] = [];
    let archiveAttempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(`/api/conversations/${conversationId}/archive`)) {
        archiveAttempts += 1;
        archiveBodies.push(JSON.parse(String(init?.body)));
        if (archiveAttempts === 1) {
          return json(
            {
              code: "CONVERSATION_CHANGED",
              message: "Conversation changed",
              requestId: "request-stale",
            },
            409,
          );
        }
        return json({ ...canonical, isArchived: true, revision: 5 });
      }
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        return json(detail(canonical));
      }
      if (url.includes("/api/conversations?")) {
        return json({ conversations: [], nextCursor: null });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
      conversationQueryKeys.detail(queryScope, conversationId),
      { pages: [detail(conversation)], pageParams: [undefined] },
    );
    const user = userEvent.setup();
    renderActions(queryClient, true);

    await user.click(screen.getByRole("button", { name: `Acciones de “${conversation.title}”` }));
    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.archive }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(copy.conversations.common.changed);
    await user.click(screen.getByRole("button", { name: copy.conversations.common.retry }));

    // The concurrent change was a rename: the retry re-sends the archive intent
    // against the recovered revision and never issues an unarchive.
    await waitFor(() => expect(archiveAttempts).toBe(2));
    expect(archiveBodies[1]).toEqual({ observedRevision: canonical.revision });
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/unarchive"))).toBe(
      false,
    );
  });

  it("keeps the retryable error visible across disclosure close and reopen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith(`/api/conversations/${conversationId}/archive`)) {
          return json(
            { code: "INTERNAL_ERROR", message: "Internal error", requestId: "request-archive" },
            500,
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    renderActions();

    const trigger = screen.getByRole("button", { name: `Acciones de “${conversation.title}”` });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.archive }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      copy.conversations.common.genericError,
    );

    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
    await user.click(trigger);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(copy.conversations.common.genericError);
    expect(screen.getByRole("button", { name: copy.conversations.common.retry })).toBeEnabled();
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it("fences rename and delete while canonical recovery is pending", async () => {
    let releaseRecovery!: (response: Response) => void;
    const pendingRecovery = new Promise<Response>((resolve) => {
      releaseRecovery = resolve;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(`/api/conversations/${conversationId}/archive`)) {
        return json(
          {
            code: "CONVERSATION_CHANGED",
            message: "Conversation changed",
            requestId: "request-stale",
          },
          409,
        );
      }
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        return pendingRecovery;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
      conversationQueryKeys.detail(queryScope, conversationId),
      { pages: [detail(conversation)], pageParams: [undefined] },
    );
    const user = userEvent.setup();
    renderActions(queryClient, true);

    const trigger = screen.getByRole("button", { name: `Acciones de “${conversation.title}”` });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.archive }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith(conversationId))).toBe(
        true,
      ),
    );

    // While the canonical refetch is still in flight every row would negotiate
    // with a revision that is known to be stale, so all are fenced.
    expect(
      screen.getByRole("button", { name: copy.conversations.conversation.rename }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: copy.conversations.conversation.delete }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: copy.conversations.conversation.archive }),
    ).toBeDisabled();

    releaseRecovery(
      json(detail({ ...conversation, revision: 4, updatedAt: "2026-08-14T12:01:00.000Z" })),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: copy.conversations.conversation.rename }),
      ).toBeEnabled(),
    );
  });

  it("negotiates rename against the revision observed when the dialog opened", async () => {
    const remoteRename = {
      ...conversation,
      title: "Título remoto",
      revision: 4,
      updatedAt: "2026-08-14T12:01:00.000Z",
    } satisfies ConversationSummary;
    const recovered = {
      ...remoteRename,
      revision: 5,
      updatedAt: "2026-08-14T12:02:00.000Z",
    } satisfies ConversationSummary;
    const titleBodies: { title: string; observedRevision: number }[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(`/api/conversations/${conversationId}/title`)) {
        const body = JSON.parse(String(init?.body)) as { title: string; observedRevision: number };
        titleBodies.push(body);
        if (body.observedRevision !== recovered.revision) {
          return json(
            {
              code: "CONVERSATION_CHANGED",
              message: "Conversation changed",
              requestId: "request-stale-rename",
            },
            409,
          );
        }
        return json({ ...recovered, title: body.title, revision: 6 });
      }
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        return json(detail(recovered));
      }
      if (url.includes("/api/conversations?")) {
        return json({ conversations: [], nextCursor: null });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
      conversationQueryKeys.detail(queryScope, conversationId),
      { pages: [detail(conversation)], pageParams: [undefined] },
    );
    const user = userEvent.setup();
    renderActions(queryClient, true);

    await user.click(screen.getByRole("button", { name: `Acciones de “${conversation.title}”` }));
    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.rename }));
    const input = screen.getByRole("textbox", {
      name: copy.conversations.conversation.titleLabel,
    });
    await user.clear(input);
    await user.type(input, "Nombre local");

    // A remote rename lands while the dialog is open: the local text survives and
    // the submission still negotiates with the revision observed at open time.
    act(() => {
      queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
        conversationQueryKeys.detail(queryScope, conversationId),
        { pages: [detail(remoteRename)], pageParams: [undefined] },
      );
    });
    expect(
      screen.getByRole("textbox", { name: copy.conversations.conversation.titleLabel }),
    ).toHaveValue("Nombre local");

    await user.click(
      screen.getByRole("button", { name: copy.conversations.conversation.saveTitle }),
    );
    await waitFor(() => expect(titleBodies).toHaveLength(1));
    expect(titleBodies[0]).toEqual({ title: "Nombre local", observedRevision: 3 });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(copy.conversations.common.changed);
    await user.click(screen.getByRole("button", { name: copy.conversations.common.retry }));
    expect(
      screen.getByRole("textbox", { name: copy.conversations.conversation.titleLabel }),
    ).toHaveValue("Nombre local");
    await user.click(
      screen.getByRole("button", { name: copy.conversations.conversation.saveTitle }),
    );

    // The recovery updated the baseline: the retried rename sends the recovered
    // revision and succeeds.
    await waitFor(() => expect(titleBodies).toHaveLength(2));
    expect(titleBodies[1]).toEqual({ title: "Nombre local", observedRevision: recovered.revision });
  });

  it("retains rename intent and the draft cache while adopting a stale canonical revision", async () => {
    const canonical = {
      ...conversation,
      revision: 4,
      updatedAt: "2026-08-14T12:01:00.000Z",
    } satisfies ConversationSummary;
    const draftScope = { kind: "conversation", conversationId } as const;
    const cachedDraft = {
      scope: draftScope,
      content: "Borrador que debe sobrevivir",
      revision: 2,
      updatedAt: "2026-08-14T12:00:30.000Z",
    } as const;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(`/api/conversations/${conversationId}/title`)) {
        return json(
          {
            code: "CONVERSATION_CHANGED",
            message: "Conversation changed",
            requestId: "request-stale-rename",
          },
          409,
        );
      }
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        return json(detail(canonical));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
      conversationQueryKeys.detail(queryScope, conversationId),
      { pages: [detail(conversation)], pageParams: [undefined] },
    );
    queryClient.setQueryData(conversationQueryKeys.draft(queryScope, draftScope), cachedDraft);
    const user = userEvent.setup();
    renderActions(queryClient, true);

    await user.click(screen.getByRole("button", { name: `Acciones de “${conversation.title}”` }));
    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.rename }));
    const input = screen.getByRole("textbox", {
      name: copy.conversations.conversation.titleLabel,
    });
    await user.clear(input);
    await user.type(input, "Nombre local pendiente");
    await user.click(
      screen.getByRole("button", { name: copy.conversations.conversation.saveTitle }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(copy.conversations.common.changed);
    expect(alert).toHaveFocus();
    expect(queryClient.getQueryData(conversationQueryKeys.draft(queryScope, draftScope))).toEqual(
      cachedDraft,
    );

    await user.click(screen.getByRole("button", { name: copy.conversations.common.retry }));
    expect(
      screen.getByRole("dialog", { name: copy.conversations.conversation.renameTitle }),
    ).toHaveAttribute("open");
    expect(
      screen.getByRole("textbox", { name: copy.conversations.conversation.titleLabel }),
    ).toHaveValue("Nombre local pendiente");
  });

  it("reopens delete confirmation after a stale revision is adopted", async () => {
    const canonical = {
      ...conversation,
      revision: 4,
      updatedAt: "2026-08-14T12:01:00.000Z",
    } satisfies ConversationSummary;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith(`/api/conversations/${conversationId}`) && init?.method === "DELETE") {
        return json(
          {
            code: "CONVERSATION_CHANGED",
            message: "Conversation changed",
            requestId: "request-stale-delete",
          },
          409,
        );
      }
      if (url.endsWith(`/api/conversations/${conversationId}`)) {
        return json(detail(canonical));
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
      conversationQueryKeys.detail(queryScope, conversationId),
      { pages: [detail(conversation)], pageParams: [undefined] },
    );
    const user = userEvent.setup();
    renderActions(queryClient, true);

    await user.click(screen.getByRole("button", { name: `Acciones de “${conversation.title}”` }));
    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.delete }));
    await user.click(
      screen.getByRole("button", { name: copy.conversations.conversation.confirmDelete }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(copy.conversations.common.changed);
    expect(alert).toHaveFocus();
    await user.click(screen.getByRole("button", { name: copy.conversations.common.retry }));
    expect(
      screen.getByRole("dialog", { name: copy.conversations.conversation.deleteTitle }),
    ).toHaveAttribute("open");
    expect(
      screen.getByRole("button", { name: copy.conversations.conversation.confirmDelete }),
    ).toBeEnabled();
  });

  it("prevents dismissing delete confirmation while deletion is pending", async () => {
    let finishDelete: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith(`/api/conversations/${conversationId}`)) {
          return new Promise<Response>((resolve) => {
            finishDelete = resolve;
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const user = userEvent.setup();
    renderActions();

    await user.click(screen.getByRole("button", { name: `Acciones de “${conversation.title}”` }));
    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.delete }));
    await user.click(
      screen.getByRole("button", { name: copy.conversations.conversation.confirmDelete }),
    );

    const dialog = screen.getByRole("dialog", {
      name: copy.conversations.conversation.deleteTitle,
    });
    expect(
      screen.getByRole("button", { name: copy.conversations.conversation.cancel }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: copy.conversations.conversation.deleting }),
    ).toBeDisabled();
    expect(dialog.dispatchEvent(new Event("cancel", { cancelable: true }))).toBe(false);
    expect(dialog).toHaveAttribute("open");

    await act(async () => {
      finishDelete?.(
        json(
          { code: "INTERNAL_ERROR", message: "Internal error", requestId: "request-delete" },
          500,
        ),
      );
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      copy.conversations.common.genericError,
    );
    expect(
      screen.getByRole("button", { name: copy.conversations.conversation.cancel }),
    ).toBeEnabled();
  });

  it("removes canonical state and returns to a focused-new-chat route after deletion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith(`/api/conversations/${conversationId}`)) {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData<InfiniteData<ConversationDetailResponse>>(
      conversationQueryKeys.detail(queryScope, conversationId),
      { pages: [detail(conversation)], pageParams: [undefined] },
    );
    const user = userEvent.setup();
    const { router } = renderActions(queryClient, true);

    await user.click(screen.getByRole("button", { name: `Acciones de “${conversation.title}”` }));
    await user.click(screen.getByRole("button", { name: copy.conversations.conversation.delete }));
    await user.click(
      screen.getByRole("button", { name: copy.conversations.conversation.confirmDelete }),
    );

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(router.state.location.state).toEqual({ focusComposer: true });
    expect(
      queryClient.getQueryData(conversationQueryKeys.detail(queryScope, conversationId)),
    ).toBeUndefined();
  });
});
