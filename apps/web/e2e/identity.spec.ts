import { expect, test } from "@playwright/test";

import { copy } from "../src/copy";

const session = {
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

test.beforeEach(async ({ page }) => {
  await page.route("**/api/health/ready", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ready", database: "up" }),
    });
  });
});

test("renders the responsive Spanish sign-in form accessibly", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.route("**/api/auth/sign-in/email", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password",
      }),
    });
  });
  await page.goto("/sign-in");

  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await expect(page).toHaveTitle(copy.brand.pageTitle(copy.identity.signIn.title));
  const brandLink = page.getByRole("link", { name: copy.brand.homeLabel });
  const heading = page.getByRole("heading", { level: 1, name: copy.identity.signIn.title });
  const email = page.getByLabel(copy.identity.common.emailLabel);
  const forgotPassword = page.getByRole("link", { name: copy.identity.signIn.forgotPassword });
  const password = page.getByLabel(copy.identity.common.passwordLabel);
  await expect(brandLink).toBeVisible();
  await expect(brandLink).toHaveCSS("transition-duration", "0s");
  await expect(heading).toBeFocused();
  await expect(email).toHaveAttribute("autocomplete", "username");
  await expect(email).toHaveCSS("border-color", "rgb(91, 107, 116)");
  await expect(password).toHaveAttribute("autocomplete", "current-password");
  await expect(page.getByRole("status")).toContainText(copy.service.ready.status);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);

  await page.keyboard.press("Tab");
  await expect(email).toBeFocused();
  await email.fill("ana@example.test");
  await page.keyboard.press("Tab");
  await expect(forgotPassword).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(password).toBeFocused();
  await password.fill("abcdefghijkl");
  await password.press("Enter");
  await expect(page.getByRole("alert")).toBeFocused();
});

test("redirects an anonymous protected route without rendering protected data", async ({
  page,
}) => {
  await page.route("**/api/session", async (route) => {
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        code: "AUTHENTICATION_REQUIRED",
        message: "Authentication required",
        requestId: "request-1",
      }),
    });
  });

  await page.goto("/");

  await expect(
    page.getByRole("heading", { level: 1, name: copy.identity.signIn.title }),
  ).toBeVisible();
  await expect(page.getByText(session.employee.email)).toHaveCount(0);
});

test("renders only the minimal protected checkpoint for an active member", async ({ page }) => {
  await page.route("**/api/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(session),
    });
  });

  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      level: 1,
      name: copy.identity.checkpoint.title(session.employee.name),
    }),
  ).toBeVisible();
  await expect(page.getByText(session.workspace.name)).toBeVisible();
  await expect(page.getByText(copy.identity.roles.admin)).toBeVisible();
  await expect(
    page.getByRole("link", { name: copy.identity.checkpoint.securityLink }),
  ).toBeVisible();
});

test("removes a password-reset token from the visible URL before input", async ({ page }) => {
  await page.goto("/reset-password?token=browser-secret");

  await expect(page).toHaveURL(/\/reset-password$/);
  await expect(
    page.getByRole("heading", { level: 1, name: copy.identity.resetPassword.title }),
  ).toBeVisible();
  await expect(page.getByLabel(copy.identity.common.newPasswordLabel)).toHaveAttribute(
    "autocomplete",
    "new-password",
  );
  await expect(page.locator("body")).not.toContainText("browser-secret");
});
