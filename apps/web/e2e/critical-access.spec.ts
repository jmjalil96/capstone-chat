import { expect, test } from "@playwright/test";

import { copy } from "../src/copy";
import {
  followConversationAccountLink,
  openAuthenticatedBrowserEmployee,
} from "./support/phase5-fixture";

test("@critical-access protects administrator routes and opens a seeded member new chat", async ({
  isMobile,
  page,
}) => {
  await page.context().clearCookies();
  await page.goto("/admin/employees");
  await expect(page).toHaveURL(/\/sign-in$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: copy.identity.signIn.title }),
  ).toBeVisible();

  await openAuthenticatedBrowserEmployee(page, isMobile);
  await expect(page).toHaveURL(/\/$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: copy.conversations.newChat.title }),
  ).toBeVisible();
  const draft = page.getByRole("textbox", { name: copy.conversations.draft.label });
  await expect(draft).toBeVisible();

  if (isMobile) {
    await expect(
      page.getByRole("button", { name: copy.conversations.navigation.open }),
    ).toBeVisible();
    await expect(page.locator(".desktop-sidebar")).not.toBeVisible();
  } else {
    await expect(draft).toBeFocused();
    await expect(page.locator(".desktop-sidebar")).toBeVisible();
  }

  await followConversationAccountLink(
    page,
    copy.conversations.navigation.assistantRules,
    Boolean(isMobile),
  );
  await expect(page).toHaveURL(/\/account\/assistant-rules$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: copy.identity.assistantRules.title }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: copy.administration.assistant.label }),
  ).toHaveCount(0);

  const administratorRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/admin/")) {
      administratorRequests.push(request.url());
    }
  });
  await page.goto("/admin/employees");

  await expect(page).toHaveURL(/\/$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: copy.conversations.newChat.title }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: copy.administration.employees.title }),
  ).toHaveCount(0);
  expect(administratorRequests).toEqual([]);
});
