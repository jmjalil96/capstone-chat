import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { copy } from "../src/copy";

const administratorsByProject = Object.freeze({
  chromium: Object.freeze({
    email: "admin.chromium.browser@example.test",
    name: "Administradora Chromium",
  }),
  "firefox-critical-streams": Object.freeze({
    email: "admin.firefox.browser@example.test",
    name: "Administradora Firefox",
  }),
  "webkit-critical-streams": Object.freeze({
    email: "admin.webkit.browser@example.test",
    name: "Administradora WebKit",
  }),
});
const originalPassword = "browser-original-password";
const changedPassword = "browser-changed-password";
const resetPassword = "browser-reset-password";

test.skip(
  ({ channel, isMobile }) => channel !== undefined || isMobile,
  "The identity lifecycle runs once per distinct browser engine to preserve production rate limits.",
);

interface MailboxMessage {
  readonly purpose: "invitation" | "password-reset" | "verification";
  readonly text: string;
  readonly to: string;
}

async function deliveryLink(
  page: Page,
  purpose: MailboxMessage["purpose"],
  recipient: string,
): Promise<string> {
  let captured: string | undefined;

  await expect
    .poll(async () => {
      const response = await page.request.get("/api/dev/mailbox");
      if (!response.ok()) {
        return undefined;
      }

      const mailbox = (await response.json()) as { messages?: MailboxMessage[] };
      const message = mailbox.messages?.findLast(
        (candidate) => candidate.purpose === purpose && candidate.to === recipient,
      );
      captured = message?.text.match(/https?:\/\/[^\s]+/u)?.[0];
      return captured;
    })
    .not.toBeUndefined();

  if (captured === undefined) {
    throw new Error(`No ${purpose} link was delivered`);
  }
  return captured;
}

async function signIn(
  page: Page,
  administrator: Readonly<{ email: string; name: string }>,
  password: string,
): Promise<void> {
  await page.goto("/sign-in");
  await page.getByLabel(copy.identity.common.emailLabel).fill(administrator.email);
  await page.getByLabel(copy.identity.common.passwordLabel, { exact: true }).fill(password);
  await page.getByRole("button", { name: copy.identity.signIn.submit }).click();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: copy.conversations.newChat.title,
    }),
  ).toBeVisible();
}

test("@critical-identity completes the real approved identity lifecycle through the browser", async ({
  page,
}, testInfo) => {
  const administrator =
    administratorsByProject[testInfo.project.name as keyof typeof administratorsByProject];
  if (administrator === undefined) {
    throw new Error(`The ${testInfo.project.name} identity administrator is not configured`);
  }

  const invitation = new URL(await deliveryLink(page, "invitation", administrator.email));
  expect(invitation.pathname).toBe("/sign-up");
  expect(invitation.search).toBe("");

  await page.goto(invitation.href);
  await page.getByLabel(copy.identity.common.nameLabel).fill(administrator.name);
  await page.getByLabel(copy.identity.common.emailLabel).fill(administrator.email);
  await page.getByLabel(copy.identity.common.passwordLabel, { exact: true }).fill(originalPassword);
  await page.getByLabel(copy.identity.common.confirmPasswordLabel).fill(originalPassword);
  await page.getByRole("button", { name: copy.identity.signUp.submit }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: copy.identity.signUp.successTitle }),
  ).toBeVisible();

  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: copy.identity.signIn.title }),
  ).toBeVisible();

  const verificationLink = await deliveryLink(page, "verification", administrator.email);
  await page.goto(verificationLink);
  await expect(page).toHaveURL(/\/verify-email$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: copy.identity.verifyEmail.verifiedTitle }),
  ).toBeVisible();

  await signIn(page, administrator, originalPassword);
  const desktopSidebar = page.locator(".desktop-sidebar");
  await expect(desktopSidebar.getByText("Capstone Ecuador")).toBeVisible();
  await desktopSidebar.getByText(administrator.name, { exact: true }).click();
  await expect(desktopSidebar.getByText(copy.identity.roles.admin, { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: copy.conversations.newChat.title,
    }),
  ).toBeVisible();

  await desktopSidebar.getByText(administrator.name, { exact: true }).click();
  await desktopSidebar.getByRole("link", { name: copy.administration.navigation.label }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: copy.administration.employees.title }),
  ).toBeVisible();
  const pendingEmployeeEmail = `phase8.pending.${testInfo.project.name}@example.test`;
  await page.getByLabel(copy.administration.employees.email).fill(pendingEmployeeEmail);
  await page.getByLabel(copy.administration.employees.role).selectOption("member");
  await page.getByRole("button", { name: copy.administration.employees.approve }).click();
  await expect(page.getByText(copy.administration.employees.invitationSent)).toBeVisible();
  await expect(page.getByRole("rowheader", { name: pendingEmployeeEmail })).toBeVisible();

  await page.getByRole("link", { name: copy.administration.navigation.models }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: copy.administration.models.title }),
  ).toBeVisible();
  await expect(page.getByLabel(copy.administration.models.monthlyBudget)).toHaveValue("100");
  await page.getByRole("link", { name: copy.administration.navigation.usage }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: copy.administration.usage.title }),
  ).toBeVisible();
  await page.getByRole("link", { name: copy.administration.navigation.backToChat }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: copy.conversations.newChat.title }),
  ).toBeVisible();

  await desktopSidebar.getByText(administrator.name, { exact: true }).click();
  await desktopSidebar.getByRole("link", { name: copy.conversations.navigation.security }).click();
  await page.getByLabel(copy.identity.common.currentPasswordLabel).fill(originalPassword);
  await page.getByLabel(copy.identity.common.newPasswordLabel).fill(changedPassword);
  await page.getByLabel(copy.identity.common.confirmPasswordLabel).fill(changedPassword);
  await page.getByRole("button", { name: copy.identity.security.submit }).click();
  await expect(page.locator(".form-message[role='status']")).toContainText(
    copy.identity.security.success,
  );
  await page.getByRole("link", { name: copy.identity.common.backToHome }).click();
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: copy.conversations.newChat.title,
    }),
  ).toBeVisible();

  await desktopSidebar.getByText(administrator.name, { exact: true }).click();
  await desktopSidebar.getByRole("button", { name: copy.conversations.navigation.signOut }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: copy.identity.signIn.title }),
  ).toBeVisible();
  await page.getByRole("link", { name: copy.identity.signIn.forgotPassword }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: copy.identity.forgotPassword.title }),
  ).toBeVisible();
  await page.getByLabel(copy.identity.common.emailLabel).fill(administrator.email);
  await page.getByRole("button", { name: copy.identity.forgotPassword.submit }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: copy.identity.forgotPassword.successTitle }),
  ).toBeVisible();

  const resetLink = await deliveryLink(page, "password-reset", administrator.email);
  await page.goto(resetLink);
  await expect(page).toHaveURL(/\/reset-password$/u);
  await page.getByLabel(copy.identity.common.newPasswordLabel).fill(resetPassword);
  await page.getByLabel(copy.identity.common.confirmPasswordLabel).fill(resetPassword);
  await page.getByRole("button", { name: copy.identity.resetPassword.submit }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: copy.identity.resetPassword.successTitle }),
  ).toBeVisible();

  if (testInfo.project.name === "chromium") {
    await signIn(page, administrator, resetPassword);
    await desktopSidebar.getByText(administrator.name, { exact: true }).click();
    await desktopSidebar
      .getByRole("button", { name: copy.conversations.navigation.signOut })
      .click();
    await expect(
      page.getByRole("heading", { level: 1, name: copy.identity.signIn.title }),
    ).toBeVisible();
  }
});
