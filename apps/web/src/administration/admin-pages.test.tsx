import type {
  AdminEmployeeListResponse,
  AdminModelPolicyResponse,
  AdminUsageResponse,
  SessionResponse,
} from "@capstone/protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Navigate, Outlet } from "react-router";
import { RouterProvider } from "react-router/dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copy } from "../copy";
import { AdminGuard } from "./admin-guard";
import { AdminShell } from "./admin-shell";
import { EmployeesPage } from "./employees-page";
import { formatAdminUsd } from "./formatting";
import { ModelsPage } from "./models-page";
import { ReportsPage } from "./reports-page";
import { UsagePage } from "./usage-page";

const session = {
  employee: { id: "employee-admin", name: "Ana Pérez", email: "ana@example.test" },
  workspace: {
    id: "workspace-1",
    identity: "capstone",
    name: "Capstone",
    role: "admin",
  },
  session: {
    createdAt: "2026-08-08T12:00:00.000Z",
    expiresAt: "2026-08-15T12:00:00.000Z",
  },
} satisfies SessionResponse;

const catalogId = "11111111-1111-4111-8111-111111111111";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function SessionOutlet() {
  return <Outlet context={session} />;
}

function renderAdministration(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [
      {
        Component: SessionOutlet,
        children: [
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
                  { path: "reports", Component: ReportsPage },
                ],
              },
            ],
          },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { queryClient, router, user };
}

function modelPolicy(revision: number, monthlyBudgetUsd: string): AdminModelPolicyResponse {
  const catalog = {
    modelId: "capstone/approved-model",
    displayName: "Modelo aprobado",
    available: true,
    contextLength: 131_072,
    maximumOutputTokens: 16_384,
    validatedAt: "2026-08-08T12:00:00.000Z",
  } as const;
  return {
    revision,
    currency: "USD",
    defaultTier: "balanced",
    monthlyBudgetUsd,
    tiers: [
      {
        tier: "fast",
        catalogId,
        enabled: true,
        available: true,
        maximumOutputTokens: 4096,
        catalog,
      },
      {
        tier: "balanced",
        catalogId,
        enabled: true,
        available: true,
        maximumOutputTokens: 8192,
        catalog,
      },
      {
        tier: "pro",
        catalogId,
        enabled: true,
        available: true,
        maximumOutputTokens: 16_384,
        catalog,
      },
    ],
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("administration pages", () => {
  it("redirects /admin, preserves semantic employee states, validates email, and restores dialog focus", async () => {
    const employees = {
      items: [
        {
          approvalId: "20000000-0000-4000-8000-000000000001",
          userId: null,
          name: null,
          email: "pending@example.test",
          role: "member",
          status: "pending",
          monthlySoftBudgetUsd: null,
        },
        {
          approvalId: "20000000-0000-4000-8000-000000000002",
          userId: "employee-2",
          name: "Luis Pérez",
          email: "luis@example.test",
          role: "member",
          status: "active",
          monthlySoftBudgetUsd: "25.000000000000000000",
        },
        {
          approvalId: "20000000-0000-4000-8000-000000000003",
          userId: "employee-3",
          name: "María Díaz",
          email: "maria@example.test",
          role: "admin",
          status: "deactivated",
          monthlySoftBudgetUsd: "10.000000000000000000",
        },
      ],
      nextCursor: null,
    } satisfies AdminEmployeeListResponse;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url === "/api/admin/employees" && method === "GET") {
        return json(employees);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { router, user } = renderAdministration("/admin");

    expect(
      await screen.findByRole("heading", { name: copy.administration.employees.title }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe("/admin/employees");
    expect(
      screen.getByRole("navigation", { name: copy.administration.navigation.label }),
    ).toBeVisible();

    const pendingRow = await screen.findByRole("row", { name: /pending@example\.test/iu });
    const activeRow = screen.getByRole("row", { name: /luis@example\.test/iu });
    const deactivatedRow = screen.getByRole("row", { name: /maria@example\.test/iu });
    expect(
      within(pendingRow).getByRole("button", { name: copy.administration.employees.resend }),
    ).toBeVisible();
    expect(
      within(activeRow).getByRole("button", { name: copy.administration.employees.revokeSessions }),
    ).toBeVisible();
    expect(
      within(deactivatedRow).getByText(
        (_, element) => element?.textContent === formatAdminUsd("10"),
      ),
    ).toBeVisible();
    expect(within(deactivatedRow).queryByRole("button")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: copy.administration.employees.approve }));
    expect(screen.getByRole("alert")).toHaveTextContent(copy.identity.common.validationSummary);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const deactivateButton = within(activeRow).getByRole("button", {
      name: copy.administration.employees.deactivate,
    });
    await user.click(deactivateButton);
    expect(
      screen.getByRole("dialog", { name: copy.administration.employees.deactivateTitle }),
    ).toHaveTextContent("luis@example.test");
    await user.click(screen.getByRole("button", { name: copy.administration.common.cancel }));
    await waitFor(() => expect(deactivateButton).toHaveFocus());
  });

  it("preserves local policy edits across a stale revision and retries with the refreshed revision", async () => {
    let policyReads = 0;
    const writes: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      if (url === "/api/admin/model-catalog" && method === "GET") {
        return json({
          items: [
            {
              catalogId,
              modelId: "capstone/approved-model",
              displayName: "Modelo aprobado",
              available: true,
              contextLength: 131_072,
              maximumOutputTokens: 16_384,
              validatedAt: "2026-08-08T12:00:00.000Z",
            },
          ],
          nextCursor: null,
        });
      }
      if (url === "/api/admin/model-policy" && method === "GET") {
        policyReads += 1;
        return json(modelPolicy(policyReads === 1 ? 1 : 2, policyReads === 1 ? "100" : "110"));
      }
      if (url === "/api/admin/model-policy" && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        writes.push(body);
        if (writes.length === 1) {
          return json(
            {
              code: "MODEL_POLICY_CHANGED",
              message: "Policy changed",
              requestId: "request-stale",
            },
            409,
          );
        }
        return json(modelPolicy(3, String(body.monthlyBudgetUsd)));
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { user } = renderAdministration("/admin/models");

    const budget = await screen.findByRole("textbox", {
      name: copy.administration.models.monthlyBudget,
    });
    expect(screen.getByText("capstone/approved-model")).toBeVisible();
    expect(screen.getByText("131.072")).toBeVisible();
    await user.clear(budget);
    await user.type(budget, "125");
    await user.click(screen.getByRole("button", { name: copy.administration.common.save }));

    expect(await screen.findByText(copy.administration.models.stale)).toBeVisible();
    await waitFor(() => expect(policyReads).toBe(2));
    expect(budget).toHaveValue("125");

    await user.click(screen.getByRole("button", { name: copy.administration.common.save }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes.map((write) => write.observedRevision)).toEqual([1, 2]);
    expect(await screen.findByText(copy.administration.models.saved)).toBeVisible();
  });

  it("renders exact decimal and large token strings without linking to employee content", async () => {
    const usage = {
      period: {
        start: "2026-08-01T05:00:00.000Z",
        end: "2026-09-01T05:00:00.000Z",
        timezone: "America/Guayaquil",
      },
      budget: {
        monthlyBudgetUsd: "100.000000000000000000",
        actualCostUsd: "0.000000000000000001",
        estimatedCostUsd: "1.000000000000000000",
        reservedCostUsd: "2.000000000000000000",
        remainingUsd: "97.000000000000000000",
      },
      items: [
        {
          employee: { id: "employee-2", name: "Luis Pérez", email: "luis@example.test" },
          softBudget: {
            monthlyBudgetUsd: "1.000000000000000000",
            consumedUsd: "3.000000000000000000",
            warning: true,
          },
          groups: [
            {
              tier: "fast",
              purpose: "compaction",
              generationCount: 1,
              promptTokens: "9007199254740993",
              completionTokens: "4",
              reasoningTokens: "0",
              cachedTokens: "0",
              actualCostUsd: "0.000000000000000001",
              estimatedCostUsd: "0",
            },
          ],
        },
      ],
      nextCursor: null,
    } satisfies AdminUsageResponse;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(usage)));
    renderAdministration("/admin/usage");

    expect(await screen.findByText(copy.administration.usage.softWarning)).toBeVisible();
    const exactCost = formatAdminUsd("0.000000000000000001");
    expect(screen.getAllByText((_, element) => element?.textContent === exactCost)).toHaveLength(2);
    expect(
      screen.getByText(
        new Intl.NumberFormat("es-EC", { maximumFractionDigits: 0 }).format(9_007_199_254_740_993n),
      ),
    ).toBeVisible();
    expect(screen.getByText(copy.administration.usage.purposes.compaction)).toBeVisible();
    expect(
      within(
        screen.getByRole("region", {
          name: `${copy.administration.usage.employee}: Luis Pérez`,
        }),
      ).queryByRole("link"),
    ).not.toBeInTheDocument();
  });

  it("renders the read-only report inbox, opens the consented pair, and handles a vanished report", async () => {
    const reportId = "3f6c1a1e-6d7c-4a1c-9d2e-6b2f6f0f5c11";
    const item = {
      id: reportId,
      reporter: { name: "Luis Pérez", email: "luis@example.test" },
      reason: "outdated",
      note: "El monto cambió.",
      createdAt: "2026-08-15T12:00:00.000Z",
    } as const;
    let detailCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/api/admin/answer-reports/${reportId}`)) {
        detailCalls += 1;
        if (detailCalls === 1) {
          return json({ ...item, exchange: { prompt: "¿Prima?", answer: "La prima es 120." } });
        }
        return json({ code: "NOT_FOUND", message: "gone", requestId: "r" }, 404);
      }
      return json({ items: detailCalls === 0 ? [item] : [], nextCursor: null });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { user } = renderAdministration("/admin/reports");

    expect(await screen.findByText("Luis Pérez")).toBeVisible();
    expect(screen.getByText("El monto cambió.")).toBeVisible();
    expect(screen.queryByRole("link", { name: /conversaci/iu })).not.toBeInTheDocument();
    // The pair is fetched only when opened.
    expect(detailCalls).toBe(0);
    const open = screen.getByRole("button", { name: /Ver mensajes del reporte 1:/u });
    expect(open).toHaveAccessibleName(/Luis Pérez.*Desactualizada/u);
    await user.click(open);
    const dialog = await screen.findByRole("dialog", {
      name: copy.administration.reports.detailTitle,
    });
    expect(await within(dialog).findByText("La prima es 120.")).toBeVisible();
    expect(within(dialog).getByText("¿Prima?")).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", { name: copy.administration.reports.close }),
    );
    await waitFor(() => expect(dialog).not.toBeVisible());
    await waitFor(() => expect(open).toHaveFocus());

    // A report deleted with its source closes the dialog and refreshes the list.
    await user.click(open);
    const unavailable = await screen.findByText(copy.administration.reports.unavailable);
    expect(unavailable).toBeVisible();
    await waitFor(() => expect(unavailable).toHaveFocus());
    await waitFor(() => expect(screen.getByText(copy.administration.reports.empty)).toBeVisible());
  });
});
