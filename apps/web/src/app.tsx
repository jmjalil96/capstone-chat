import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { RouterProvider } from "react-router/dom";

import { AdminGuard } from "./administration/admin-guard";
import { AdminShell } from "./administration/admin-shell";
import { EmployeesPage } from "./administration/employees-page";
import { ModelsPage } from "./administration/models-page";
import { UsagePage } from "./administration/usage-page";
import { ArchivedPage } from "./conversations/archived-page";
import { ConversationPage } from "./conversations/conversation-page";
import { ConversationShell } from "./conversations/conversation-shell";
import { NewChatPage } from "./conversations/new-chat-page";
import { ProtectedDraftLayout } from "./conversations/protected-draft-layout";
import { SearchPage } from "./conversations/search-page";
import { AccountSecurityPage } from "./identity/account-security-page";
import { ForgotPasswordPage } from "./identity/forgot-password-page";
import { IdentityFrame, IdentityLayout } from "./identity/identity-layout";
import { RequireSession } from "./identity/require-session";
import { ResetPasswordPage } from "./identity/reset-password-page";
import { SignInPage } from "./identity/sign-in-page";
import { SignUpPage } from "./identity/sign-up-page";
import { VerifyEmailPage } from "./identity/verify-email-page";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

export const appRoutes = [
  {
    Component: IdentityLayout,
    children: [
      { path: "/sign-in", Component: SignInPage },
      { path: "/sign-up", Component: SignUpPage },
      { path: "/verify-email", Component: VerifyEmailPage },
      { path: "/forgot-password", Component: ForgotPasswordPage },
      { path: "/reset-password", Component: ResetPasswordPage },
    ],
  },
  {
    element: <RequireSession standalone />,
    children: [
      {
        Component: ProtectedDraftLayout,
        children: [
          {
            Component: ConversationShell,
            children: [
              { index: true, Component: NewChatPage },
              { path: "/c/:conversationId", Component: ConversationPage },
              { path: "/search", Component: SearchPage },
              { path: "/archived", Component: ArchivedPage },
            ],
          },
          {
            path: "/account/security",
            element: (
              <IdentityFrame>
                <AccountSecurityPage />
              </IdentityFrame>
            ),
          },
          {
            path: "/admin",
            Component: AdminGuard,
            children: [
              {
                Component: AdminShell,
                children: [
                  { index: true, element: <Navigate to="/admin/employees" replace /> },
                  { path: "employees", Component: EmployeesPage },
                  { path: "models", Component: ModelsPage },
                  { path: "usage", Component: UsagePage },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
] satisfies RouteObject[];

const router = createBrowserRouter(appRoutes);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
