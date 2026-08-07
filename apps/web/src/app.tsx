import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { RouterProvider } from "react-router/dom";

import { AccountSecurityPage } from "./identity/account-security-page";
import { CheckpointPage } from "./identity/checkpoint-page";
import { ForgotPasswordPage } from "./identity/forgot-password-page";
import { IdentityLayout } from "./identity/identity-layout";
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
      {
        Component: RequireSession,
        children: [
          { index: true, Component: CheckpointPage },
          { path: "/account/security", Component: AccountSecurityPage },
        ],
      },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
] satisfies RouteObject[];

const router = createBrowserRouter(appRoutes);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
