import type { SessionResponse } from "@capstone/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, describe, expect, it } from "vitest";

import { AdminGuard } from "./admin-guard";

function session(role: "admin" | "member"): SessionResponse {
  return {
    employee: { id: "employee-1", name: "Ana Pérez", email: "ana@example.test" },
    workspace: { id: "workspace-1", identity: "capstone", name: "Capstone", role },
    session: {
      createdAt: "2026-08-08T12:00:00.000Z",
      expiresAt: "2026-08-15T12:00:00.000Z",
    },
  };
}

function SessionOutlet({ value }: { readonly value: SessionResponse }) {
  return <Outlet context={value} />;
}

afterEach(cleanup);

describe("AdminGuard", () => {
  it("renders administrator routes with the canonical session context", async () => {
    const router = createMemoryRouter(
      [
        {
          element: <SessionOutlet value={session("admin")} />,
          children: [
            {
              path: "/admin",
              Component: AdminGuard,
              children: [{ index: true, element: <h1>Área administrativa</h1> }],
            },
          ],
        },
      ],
      { initialEntries: ["/admin"] },
    );
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole("heading", { name: "Área administrativa" })).toBeVisible();
  });

  it("returns members to chat without treating the browser guard as authorization", async () => {
    const router = createMemoryRouter(
      [
        {
          element: <SessionOutlet value={session("member")} />,
          children: [
            { path: "/", element: <h1>Chat</h1> },
            {
              path: "/admin",
              Component: AdminGuard,
              children: [{ index: true, element: <h1>Área administrativa</h1> }],
            },
          ],
        },
      ],
      { initialEntries: ["/admin"] },
    );
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole("heading", { name: "Chat" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/");
  });
});
