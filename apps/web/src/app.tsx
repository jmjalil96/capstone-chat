import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { RouterProvider } from "react-router/dom";

import { ArchivedPage } from "./conversations/archived-page";
import { ConversationPage } from "./conversations/conversation-page";
import { ConversationShell } from "./conversations/conversation-shell";
import { NewChatPage } from "./conversations/new-chat-page";
import { ProtectedDraftLayout } from "./conversations/protected-draft-layout";
import { SearchPage } from "./conversations/search-page";
import { copy } from "./copy";
import { AccountSecurityPage } from "./identity/account-security-page";
import { ForgotPasswordPage } from "./identity/forgot-password-page";
import { IdentityFrame, IdentityLayout } from "./identity/identity-layout";
import { RequireSession } from "./identity/require-session";
import { ResetPasswordPage } from "./identity/reset-password-page";
import { SignInPage } from "./identity/sign-in-page";
import { SignUpPage } from "./identity/sign-up-page";
import { VerifyEmailPage } from "./identity/verify-email-page";

const AdminGuard = lazy(() =>
  import("./administration/admin-guard").then(({ AdminGuard: Component }) => ({
    default: Component,
  })),
);
const AdminShell = lazy(() =>
  import("./administration/admin-shell").then(({ AdminShell: Component }) => ({
    default: Component,
  })),
);
const EmployeesPage = lazy(() =>
  import("./administration/employees-page").then(({ EmployeesPage: Component }) => ({
    default: Component,
  })),
);
const ModelsPage = lazy(() =>
  import("./administration/models-page").then(({ ModelsPage: Component }) => ({
    default: Component,
  })),
);
const UsagePage = lazy(() =>
  import("./administration/usage-page").then(({ UsagePage: Component }) => ({
    default: Component,
  })),
);

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
      <Suspense
        fallback={
          <div className="route-loading" role="status">
            {copy.routeLoading}
          </div>
        }
      >
        <RouterProvider router={router} />
      </Suspense>
    </QueryClientProvider>
  );
}
