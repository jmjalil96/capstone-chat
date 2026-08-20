import type { SessionResponse } from "@capstone/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sessionQueryKey } from "../api/session";
import { appRoutes } from "../app";
import { conversationQueryKeys, conversationQueryScope } from "../conversations/api";
import { copy } from "../copy";

const authMocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  sendVerificationEmail: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  signUp: vi.fn(),
  verifyEmail: vi.fn(),
}));

vi.mock("./auth-actions", () => authMocks);

const validSession = {
  employee: {
    id: "employee-1",
    name: "Ana Pérez",
    email: "ana@example.test",
  },
  workspace: {
    id: "workspace-1",
    identity: "capstone",
    name: "Capstone",
    role: "admin",
  },
  session: {
    createdAt: "2026-08-06T12:00:00.000Z",
    expiresAt: "2026-08-13T12:00:00.000Z",
  },
} satisfies SessionResponse;

type SessionFixture = "authenticated" | "anonymous" | "denied" | "malformed";

function response(payload: unknown, status: number): Response {
  return {
    json: vi.fn().mockResolvedValue(payload),
    ok: status >= 200 && status < 300,
    status,
  } as unknown as Response;
}

function sessionResponse(fixture: SessionFixture): Response {
  if (fixture === "authenticated") {
    return response(validSession, 200);
  }

  if (fixture === "anonymous") {
    return response(
      {
        code: "AUTHENTICATION_REQUIRED",
        message: "Authentication required",
        requestId: "request-1",
      },
      401,
    );
  }

  if (fixture === "denied") {
    return response(
      {
        code: "WORKSPACE_ACCESS_DENIED",
        message: "Workspace access denied",
        requestId: "request-2",
      },
      403,
    );
  }

  return response({ unexpected: true }, 200);
}

function renderRoute(
  path: string,
  sessionFixture: SessionFixture = "authenticated",
  strict = false,
) {
  let draftWritesRequireAuthentication = false;
  window.history.replaceState(null, "", path);
  let draftWritesFail = false;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");

    if (url.includes("/api/health/ready")) {
      return response({ status: "ready", database: "up" }, 200);
    }

    if (url.includes("/api/session")) {
      return sessionResponse(sessionFixture);
    }

    if (url.includes("/api/conversations?")) {
      return response({ conversations: [], nextCursor: null }, 200);
    }

    if (url.includes("/api/drafts/new")) {
      if (method === "PUT") {
        if (draftWritesRequireAuthentication) {
          return response(
            {
              code: "AUTHENTICATION_REQUIRED",
              message: "Authentication required",
              requestId: "request-session-expired",
            },
            401,
          );
        }
        if (draftWritesFail) {
          return response(
            { code: "INTERNAL_ERROR", message: "Unavailable", requestId: "request-draft" },
            503,
          );
        }
        const body = JSON.parse(String(init?.body)) as {
          content: string;
          observedRevision: number;
        };
        return response(
          {
            scope: { kind: "new" },
            content: body.content,
            revision: body.observedRevision + 1,
            updatedAt: "2026-08-06T12:00:00.000Z",
          },
          200,
        );
      }
      return response(
        {
          scope: { kind: "new" },
          content: "",
          revision: 0,
          updatedAt: null,
        },
        200,
      );
    }

    if (url.includes("/api/assistant-rules")) {
      return response(
        {
          baseVersion: "capstone-chat-base-v2",
          baseText: "REGLAS BASE OBLIGATORIAS",
          workspaceText: "Usa USD para los ejemplos.",
          effectivePrompt:
            "CONTEXTO EDITABLE\n\nUsa USD para los ejemplos.\n\nREGLAS BASE OBLIGATORIAS",
          updatedAt: "2026-08-17T12:00:00.000Z",
        },
        200,
      );
    }

    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  const user = userEvent.setup();

  const application = (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  render(strict ? <StrictMode>{application}</StrictMode> : application);

  return {
    fetchMock,
    queryClient,
    router,
    setDraftWritesFailing: (failing: boolean) => {
      draftWritesFail = failing;
    },
    setDraftWritesRequireAuthentication: (required: boolean) => {
      draftWritesRequireAuthentication = required;
    },
    user,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("identity routes", () => {
  it("redirects an anonymous protected request to sign in", async () => {
    renderRoute("/", "anonymous");

    expect(
      await screen.findByRole("heading", { level: 1, name: copy.identity.signIn.title }),
    ).toBeVisible();
  });

  it("renders the protected conversation shell from the canonical Capstone session", async () => {
    renderRoute("/");

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: copy.conversations.newChat.title,
      }),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: copy.conversations.draft.label })).toHaveFocus(),
    );
    expect(screen.getByRole("link", { name: copy.conversations.common.newChat })).toBeVisible();
    expect(screen.getByRole("link", { name: copy.conversations.navigation.search })).toBeVisible();
  });

  it("persists only the approved desktop sidebar preference", async () => {
    const { fetchMock, user } = renderRoute("/");
    await screen.findByRole("heading", { name: copy.conversations.newChat.title });
    const editor = screen.getByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());
    await user.type(editor, "Texto pendiente");
    expect(screen.queryByText(copy.conversations.draft.pendingNotice)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: copy.conversations.navigation.collapse }));
    expect(Object.keys(window.localStorage)).toEqual(["capstone-chat.sidebar-collapsed.v1"]);
    expect(window.localStorage.getItem("capstone-chat.sidebar-collapsed.v1")).toBe("true");

    await user.click(screen.getByRole("button", { name: copy.conversations.navigation.expand }));
    expect(window.localStorage).toHaveLength(0);

    await user.click(screen.getAllByText(validSession.employee.name)[0] as HTMLElement);
    await user.click(screen.getByRole("link", { name: copy.conversations.navigation.security }));
    expect(
      await screen.findByRole("heading", { level: 1, name: copy.identity.security.title }),
    ).toBeVisible();
    expect(screen.queryByText(copy.conversations.draft.pendingNotice)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });

  it("flushes the active draft before opening the read-only assistant rules page", async () => {
    const { fetchMock, user } = renderRoute("/");
    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());
    await user.type(editor, "Borrador antes de consultar reglas");

    await user.click(screen.getAllByText(validSession.employee.name)[0] as HTMLElement);
    await user.click(
      screen.getByRole("link", { name: copy.conversations.navigation.assistantRules }),
    );

    expect(
      await screen.findByRole("heading", { level: 1, name: copy.identity.assistantRules.title }),
    ).toBeVisible();
    expect(
      await screen.findByText("Usa USD para los ejemplos.", { selector: "pre" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("textbox", { name: copy.administration.assistant.label }),
    ).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
  });

  it("keeps a dirty editor mounted when a POP navigation final-save fails", async () => {
    const { router, setDraftWritesFailing, user } = renderRoute("/");
    await screen.findByRole("heading", { name: copy.conversations.newChat.title });
    await router.navigate("/search");
    await screen.findByRole("heading", { name: copy.conversations.search.title });
    await router.navigate("/");
    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());

    setDraftWritesFailing(true);
    await user.type(editor, "Texto que debe permanecer");
    void router.navigate(-1);

    await waitFor(() =>
      expect(
        screen.getByText(copy.conversations.draft.unsaved, { selector: ".draft-save-status" }),
      ).toBeVisible(),
    );
    expect(router.state.location.pathname).toBe("/");
    expect(editor).toBeVisible();
    expect(editor).toHaveValue("Texto que debe permanecer");

    setDraftWritesFailing(false);
    void router.navigate(-1);
    expect(
      await screen.findByRole("heading", { level: 1, name: copy.conversations.search.title }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe("/search");
  });

  it("distinguishes denied access from a transport failure", async () => {
    const denied = renderRoute("/", "denied");
    expect(
      await screen.findByRole("heading", { name: copy.identity.route.deniedTitle }),
    ).toBeVisible();

    denied.router.dispose();
    cleanup();
    renderRoute("/", "malformed");
    expect(
      await screen.findByRole("heading", { name: copy.identity.route.unavailableTitle }),
    ).toBeVisible();
  });

  it("uses password-manager semantics and focuses a generic sign-in error", async () => {
    authMocks.signIn.mockRejectedValue(new Error("rejected"));
    const { user } = renderRoute("/sign-in");
    const email = screen.getByRole("textbox", { name: copy.identity.common.emailLabel });
    const password = screen.getByLabelText(copy.identity.common.passwordLabel);

    expect(email).toHaveAttribute("autocomplete", "username");
    expect(password).toHaveAttribute("autocomplete", "current-password");

    await user.type(email, "ana@example.test");
    await user.click(password);
    await user.paste("abcdefghijkl");
    await user.click(screen.getByRole("button", { name: copy.identity.signIn.submit }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(copy.identity.signIn.error);
    expect(alert).toHaveFocus();

    await user.click(screen.getByRole("button", { name: copy.identity.signIn.submit }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveFocus());
  });

  it("focuses route headings and updates the document title", async () => {
    const { router } = renderRoute("/sign-in");
    const signInHeading = await screen.findByRole("heading", {
      level: 1,
      name: copy.identity.signIn.title,
    });
    expect(signInHeading).toHaveFocus();
    expect(document.title).toBe(copy.brand.pageTitle(copy.identity.signIn.title));

    await router.navigate("/sign-up");
    const signUpHeading = await screen.findByRole("heading", {
      level: 1,
      name: copy.identity.signUp.title,
    });
    expect(signUpHeading).toHaveFocus();
    expect(document.title).toBe(copy.brand.pageTitle(copy.identity.signUp.title));
  });

  it("replaces the authenticated session cache immediately after sign-out", async () => {
    authMocks.signOut.mockResolvedValue(undefined);
    const { queryClient, user } = renderRoute("/");
    await screen.findByRole("heading", {
      name: copy.conversations.newChat.title,
    });
    const protectedKey = conversationQueryKeys.detail(
      conversationQueryScope(validSession),
      "private-fixture",
    );
    queryClient.setQueryData(protectedKey, { content: "must-not-survive-sign-out" });

    await user.click(screen.getAllByText(validSession.employee.name)[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: copy.conversations.navigation.signOut }));

    expect(
      await screen.findByRole("heading", { level: 1, name: copy.identity.signIn.title }),
    ).toBeVisible();
    expect(queryClient.getQueryData(sessionQueryKey)).toEqual({ status: "anonymous" });
    expect(queryClient.getQueryData(protectedKey)).toBeUndefined();
    expect(screen.queryByText(validSession.employee.email)).not.toBeInTheDocument();
  });

  it("locks draft editing while sign-out is awaiting the server", async () => {
    let finishSignOut: (() => void) | undefined;
    authMocks.signOut.mockReturnValue(
      new Promise<void>((resolve) => {
        finishSignOut = resolve;
      }),
    );
    const { user } = renderRoute("/");
    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());

    await user.click(screen.getAllByText(validSession.employee.name)[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: copy.conversations.navigation.signOut }));
    await waitFor(() => expect(authMocks.signOut).toHaveBeenCalledOnce());
    expect(editor).toBeDisabled();
    await user.type(editor, "No debe perderse");
    expect(editor).toHaveValue("");

    finishSignOut?.();
    expect(
      await screen.findByRole("heading", { level: 1, name: copy.identity.signIn.title }),
    ).toBeVisible();
  });

  it("moves an open application to sign-in when a protected request returns 401", async () => {
    const { queryClient, setDraftWritesRequireAuthentication, user } = renderRoute("/");
    const editor = await screen.findByRole("textbox", { name: copy.conversations.draft.label });
    await waitFor(() => expect(editor).toBeEnabled());
    const protectedKey = conversationQueryKeys.detail(
      conversationQueryScope(validSession),
      "private-session-expiry-fixture",
    );
    queryClient.setQueryData(protectedKey, { content: "must-be-cleared" });
    setDraftWritesRequireAuthentication(true);

    await user.type(editor, "La sesión caducó");

    expect(
      await screen.findByRole(
        "heading",
        { level: 1, name: copy.identity.signIn.title },
        { timeout: 2_000 },
      ),
    ).toBeVisible();
    expect(queryClient.getQueryData(sessionQueryKey)).toEqual({ status: "anonymous" });
    expect(queryClient.getQueryData(protectedKey)).toBeUndefined();
    expect(screen.queryByText(validSession.employee.email)).not.toBeInTheDocument();
  });

  it("fences a delayed employee draft save across a direct authenticated session change", async () => {
    const replacementSession = {
      employee: {
        id: "employee-2",
        name: "Beatriz Mora",
        email: "beatriz@example.test",
      },
      workspace: {
        id: "workspace-1",
        identity: "capstone",
        name: "Capstone",
        role: "member",
      },
      session: {
        createdAt: "2026-08-07T14:00:00.000Z",
        expiresAt: "2026-08-14T14:00:00.000Z",
      },
    } satisfies SessionResponse;
    let activeSession: SessionResponse = validSession;
    let finishEmployeeASave: ((response: Response) => void) | undefined;
    let employeeASaveSignal: AbortSignal | null | undefined;
    const draftWrites: Array<{ content: string; observedRevision: number }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");

      if (url.includes("/api/health/ready")) {
        return response({ status: "ready", database: "up" }, 200);
      }
      if (url.includes("/api/session")) {
        return response(activeSession, 200);
      }
      if (url.includes("/api/conversations?")) {
        return response({ conversations: [], nextCursor: null }, 200);
      }
      if (url.includes("/api/drafts/new") && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as {
          content: string;
          observedRevision: number;
        };
        draftWrites.push(body);
        if (activeSession.employee.id !== validSession.employee.id) {
          return response(
            {
              scope: { kind: "new" },
              content: body.content,
              revision: body.observedRevision + 1,
              updatedAt: "2026-08-07T14:00:01.000Z",
            },
            200,
          );
        }
        employeeASaveSignal = init?.signal;
        return new Promise<Response>((resolve) => {
          finishEmployeeASave = resolve;
        });
      }
      if (url.includes("/api/drafts/new")) {
        return activeSession.employee.id === validSession.employee.id
          ? response(
              {
                scope: { kind: "new" },
                content: "Base de Ana",
                revision: 8,
                updatedAt: "2026-08-06T12:00:00.000Z",
              },
              200,
            )
          : response(
              {
                scope: { kind: "new" },
                content: "Borrador canónico de Beatriz",
                revision: 0,
                updatedAt: null,
              },
              200,
            );
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const router = createMemoryRouter(appRoutes, { initialEntries: ["/"] });
    const user = userEvent.setup();

    render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </StrictMode>,
    );

    const employeeAEditor = await screen.findByRole("textbox", {
      name: copy.conversations.draft.label,
    });
    await waitFor(() => expect(employeeAEditor).toHaveValue("Base de Ana"));
    await user.clear(employeeAEditor);
    await user.type(employeeAEditor, "Secreto de Ana");
    await waitFor(() => expect(finishEmployeeASave).toBeTypeOf("function"), { timeout: 1_500 });
    expect(draftWrites).toEqual([{ content: "Secreto de Ana", observedRevision: 8 }]);

    await user.type(employeeAEditor, " con una edición posterior");
    await user.click(screen.getByRole("link", { name: copy.conversations.navigation.search }));

    activeSession = replacementSession;
    await act(async () => {
      queryClient.setQueryData(sessionQueryKey, {
        status: "authenticated",
        session: replacementSession,
      });
    });

    await waitFor(() =>
      expect(screen.getAllByText(replacementSession.employee.name)[0]).toBeVisible(),
    );
    const employeeBEditor = screen.getByRole("textbox", {
      name: copy.conversations.draft.label,
    });
    expect(employeeBEditor).not.toBe(employeeAEditor);
    await waitFor(() => expect(employeeBEditor).toHaveValue("Borrador canónico de Beatriz"));
    await waitFor(() => expect(employeeASaveSignal?.aborted).toBe(true));

    await act(async () => {
      finishEmployeeASave?.(
        response(
          {
            scope: { kind: "new" },
            content: "Secreto de Ana",
            revision: 9,
            updatedAt: "2026-08-06T12:00:01.000Z",
          },
          200,
        ),
      );
      await Promise.resolve();
    });

    const employeeAKey = conversationQueryKeys.draft(conversationQueryScope(validSession), {
      kind: "new",
    });
    const employeeBKey = conversationQueryKeys.draft(conversationQueryScope(replacementSession), {
      kind: "new",
    });
    await waitFor(() => expect(queryClient.getQueryData(employeeAKey)).toBeUndefined());
    expect(queryClient.getQueryData(employeeBKey)).toMatchObject({
      content: "Borrador canónico de Beatriz",
      revision: 0,
    });
    expect(employeeBEditor).toHaveValue("Borrador canónico de Beatriz");
    expect(router.state.location.pathname).toBe("/");
    expect(draftWrites).toHaveLength(1);

    await user.clear(employeeBEditor);
    await user.type(employeeBEditor, "Edición de Beatriz");
    await waitFor(() => expect(draftWrites).toHaveLength(2), { timeout: 1_500 });
    expect(draftWrites[1]).toEqual({
      content: "Edición de Beatriz",
      observedRevision: 0,
    });
    await waitFor(() =>
      expect(
        screen.getByText(copy.conversations.draft.saved, { selector: ".draft-save-status" }),
      ).toBeVisible(),
    );
    expect(queryClient.getQueryData(employeeAKey)).toBeUndefined();
    expect(queryClient.getQueryData(employeeBKey)).toMatchObject({
      content: "Edición de Beatriz",
      revision: 1,
    });
    expect(employeeBEditor).toHaveValue("Edición de Beatriz");
    expect(router.state.location.pathname).toBe("/");
  });

  it("submits sign-up data and shows the same generic public outcome", async () => {
    authMocks.signUp.mockResolvedValue(undefined);
    const { user } = renderRoute("/sign-up");

    await user.type(
      screen.getByRole("textbox", { name: copy.identity.common.nameLabel }),
      "Ana Pérez",
    );
    await user.type(
      screen.getByRole("textbox", { name: copy.identity.common.emailLabel }),
      "ana@example.test",
    );
    await user.type(screen.getByLabelText(copy.identity.common.passwordLabel), "abcdefghijkl");
    await user.type(
      screen.getByLabelText(copy.identity.common.confirmPasswordLabel),
      "abcdefghijkl",
    );
    await user.click(screen.getByRole("button", { name: copy.identity.signUp.submit }));

    await waitFor(() =>
      expect(authMocks.signUp.mock.calls[0]?.[0]).toEqual({
        name: "Ana Pérez",
        email: "ana@example.test",
        password: "abcdefghijkl",
      }),
    );
    expect(
      await screen.findByText(copy.identity.signUp.success, { selector: ".form-message" }),
    ).toHaveFocus();
    expect(screen.queryByText("ana@example.test")).not.toBeInTheDocument();
  });

  it("captures a verification fragment before the JSON request and removes it from the URL", async () => {
    authMocks.verifyEmail.mockImplementation(async () => {
      expect(window.location.hash).toBe("");
      expect(window.location.search).toBe("");
    });
    renderRoute("/verify-email#token=verification-secret", "authenticated", true);

    expect(
      await screen.findByRole("heading", { name: copy.identity.verifyEmail.verifiedTitle }),
    ).toBeVisible();
    expect(authMocks.verifyEmail.mock.calls[0]?.[0]).toBe("verification-secret");
    expect(authMocks.verifyEmail).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
    expect(document.body).not.toHaveTextContent("verification-secret");
    expect(window.localStorage).toHaveLength(0);
    expect(window.sessionStorage).toHaveLength(0);
  });

  it("keeps malformed and rejected verification fragments on the generic recovery path", async () => {
    renderRoute("/verify-email#token=first&token=second");

    expect(
      await screen.findByRole("heading", { name: copy.identity.verifyEmail.invalidTitle }),
    ).toBeVisible();
    expect(authMocks.verifyEmail).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");

    cleanup();
    authMocks.verifyEmail.mockRejectedValue(new Error("expired provider detail"));
    renderRoute("/verify-email#token=expired-secret");

    expect(
      await screen.findByRole("heading", { name: copy.identity.verifyEmail.invalidTitle }),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent("expired-secret");
    expect(document.body).not.toHaveTextContent("expired provider detail");
  });

  it("requests password recovery without revealing account existence", async () => {
    authMocks.requestPasswordReset.mockResolvedValue(undefined);
    const { user } = renderRoute("/forgot-password");

    await user.type(
      screen.getByRole("textbox", { name: copy.identity.common.emailLabel }),
      "unknown@example.test",
    );
    await user.click(screen.getByRole("button", { name: copy.identity.forgotPassword.submit }));

    expect(
      await screen.findByText(copy.identity.forgotPassword.success, {
        selector: ".form-message",
      }),
    ).toHaveFocus();
    expect(screen.queryByText("unknown@example.test")).not.toBeInTheDocument();
  });

  it("captures a reset token in memory and removes it from the visible URL before submission", async () => {
    authMocks.resetPassword.mockResolvedValue(undefined);
    const { user } = renderRoute("/reset-password#token=reset-secret");

    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
    const password = screen.getByLabelText(copy.identity.common.newPasswordLabel);
    const confirmation = screen.getByLabelText(copy.identity.common.confirmPasswordLabel);
    expect(password).toHaveAttribute("autocomplete", "new-password");

    await user.type(password, "abcdefghijkl");
    await user.type(confirmation, "abcdefghijkl");
    await user.click(screen.getByRole("button", { name: copy.identity.resetPassword.submit }));

    await waitFor(() =>
      expect(authMocks.resetPassword.mock.calls[0]?.[0]).toEqual({
        newPassword: "abcdefghijkl",
        token: "reset-secret",
      }),
    );
    expect(
      await screen.findByText(copy.identity.resetPassword.success, {
        selector: ".form-message",
      }),
    ).toHaveFocus();
    expect(window.localStorage).toHaveLength(0);
    expect(window.sessionStorage).toHaveLength(0);
  });

  it("changes a password with explicit other-session revocation semantics", async () => {
    authMocks.changePassword.mockResolvedValue(undefined);
    const { user } = renderRoute("/account/security");

    await screen.findByRole("heading", { name: copy.identity.security.title });
    await user.type(
      screen.getByLabelText(copy.identity.common.currentPasswordLabel),
      "abcdefghijkl",
    );
    await user.type(screen.getByLabelText(copy.identity.common.newPasswordLabel), "mnopqrstuvwx");
    await user.type(
      screen.getByLabelText(copy.identity.common.confirmPasswordLabel),
      "mnopqrstuvwx",
    );
    await user.click(screen.getByRole("button", { name: copy.identity.security.submit }));

    await waitFor(() =>
      expect(authMocks.changePassword.mock.calls[0]?.[0]).toEqual({
        currentPassword: "abcdefghijkl",
        newPassword: "mnopqrstuvwx",
      }),
    );
    expect(
      await screen.findByText(copy.identity.security.success, { selector: ".form-message" }),
    ).toHaveFocus();
    expect(screen.getByLabelText(copy.identity.common.currentPasswordLabel)).toHaveValue("");
  });
});
