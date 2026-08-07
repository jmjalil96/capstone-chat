import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sessionQueryKey } from "../api/session";
import { appRoutes } from "../app";
import { copy } from "../copy";

const authMocks = vi.hoisted(() => ({
  changePassword: vi.fn(),
  requestPasswordReset: vi.fn(),
  resetPassword: vi.fn(),
  sendVerificationEmail: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  signUp: vi.fn(),
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
};

type SessionFixture = "authenticated" | "anonymous" | "denied" | "malformed";

function response(payload: unknown, status: number): Response {
  return {
    json: vi.fn().mockResolvedValue(payload),
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

function renderRoute(path: string, sessionFixture: SessionFixture = "authenticated") {
  window.history.replaceState(null, "", path);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("/api/health/ready")) {
        return response({ status: "ready", database: "up" }, 200);
      }

      if (url.includes("/api/session")) {
        return sessionResponse(sessionFixture);
      }

      throw new Error(`Unexpected request: ${url}`);
    }),
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  const user = userEvent.setup();

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  return { queryClient, router, user };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("identity routes", () => {
  it("redirects an anonymous protected request to sign in", async () => {
    renderRoute("/", "anonymous");

    expect(
      await screen.findByRole("heading", { level: 1, name: copy.identity.signIn.title }),
    ).toBeVisible();
  });

  it("renders the protected checkpoint from the canonical Capstone session", async () => {
    renderRoute("/");

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: copy.identity.checkpoint.title(validSession.employee.name),
      }),
    ).toBeVisible();
    expect(screen.getByText(validSession.workspace.name)).toBeVisible();
    expect(screen.getByText(copy.identity.roles.admin)).toBeVisible();
    expect(screen.getByRole("link", { name: copy.identity.checkpoint.securityLink })).toBeVisible();
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
      name: copy.identity.checkpoint.title(validSession.employee.name),
    });

    await user.click(screen.getByRole("button", { name: copy.identity.checkpoint.signOut }));

    expect(
      await screen.findByRole("heading", { level: 1, name: copy.identity.signIn.title }),
    ).toBeVisible();
    expect(queryClient.getQueryData(sessionQueryKey)).toBeUndefined();
    expect(screen.queryByText(validSession.employee.email)).not.toBeInTheDocument();
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

  it("keeps verification outcomes generic and removes callback values from the URL", async () => {
    renderRoute("/verify-email?verified=1&token=must-not-remain");

    expect(
      await screen.findByRole("heading", { name: copy.identity.verifyEmail.verifiedTitle }),
    ).toBeVisible();
    expect(window.location.search).toBe("");
    expect(document.body).not.toHaveTextContent("must-not-remain");
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
    const { user } = renderRoute("/reset-password?token=reset-secret");

    expect(window.location.search).toBe("");
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
