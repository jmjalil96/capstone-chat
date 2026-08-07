import { expect, test } from "@playwright/test";

import { copy } from "../src/copy";

const employee = {
  email: "employee.browser@example.test",
  name: "Empleada de Conversaciones",
  password: "browser-conversation-password",
} as const;

test("completes the real Phase 3 conversation lifecycle through the browser", async ({
  context,
  page,
}) => {
  await page.goto("/sign-in");
  await page.getByLabel(copy.identity.common.emailLabel).fill(employee.email);
  await page
    .getByLabel(copy.identity.common.passwordLabel, { exact: true })
    .fill(employee.password);
  await page.getByRole("button", { name: copy.identity.signIn.submit }).click();

  const draft = page.getByRole("textbox", { name: copy.conversations.draft.label });
  await expect(page.getByRole("heading", { name: copy.conversations.newChat.title })).toBeVisible();
  await expect(draft).toBeFocused();
  await expect(page.getByRole("button", { name: /Enviar|Detener/u })).toHaveCount(0);
  await draft.fill("Borrador nuevo persistido para la prueba.");
  await expect(page.getByText(copy.conversations.draft.saved, { exact: true })).toBeVisible();
  await page.reload();
  await expect(draft).toHaveValue("Borrador nuevo persistido para la prueba.");
  expect(await page.evaluate(() => Object.keys(window.localStorage))).toEqual([]);

  const desktopSidebar = page.locator(".desktop-sidebar");
  await desktopSidebar
    .getByRole("button", { name: copy.conversations.navigation.collapse })
    .click();
  expect(await page.evaluate(() => Object.keys(window.localStorage))).toEqual([
    "capstone-chat.sidebar-collapsed.v1",
  ]);
  await desktopSidebar.getByRole("button", { name: copy.conversations.navigation.expand }).click();

  await desktopSidebar.getByRole("link", { name: "Plan de lanzamiento" }).click();
  await expect(page.getByText("Resumen seleccionado del proyecto Faro.")).toBeVisible();
  await expect(draft).toHaveValue("Seguimiento pendiente del proyecto Faro.");
  await expect(page.getByRole("button", { name: /Enviar|Detener/u })).toHaveCount(0);

  const otherTab = await context.newPage();
  await otherTab.goto(page.url());
  const otherDraft = otherTab.getByRole("textbox", { name: copy.conversations.draft.label });
  await expect(otherDraft).toHaveValue("Seguimiento pendiente del proyecto Faro.");
  await draft.fill("Guardado desde la primera pestaña.");
  await expect(page.getByText(copy.conversations.draft.saved, { exact: true })).toBeVisible();
  await otherDraft.fill("Versión local en conflicto.");
  await expect(
    otherTab.getByRole("heading", { name: copy.conversations.draft.conflictTitle }),
  ).toBeVisible();
  await otherTab.getByRole("button", { name: copy.conversations.draft.keepServer }).click();
  await expect(otherDraft).toHaveValue("Guardado desde la primera pestaña.");

  await draft.fill("Segundo cambio de la primera pestaña.");
  await expect(page.getByText(copy.conversations.draft.saved, { exact: true })).toBeVisible();
  await otherDraft.fill("Reemplazo local confirmado.");
  await expect(
    otherTab.getByRole("heading", { name: copy.conversations.draft.conflictTitle }),
  ).toBeVisible();
  await otherTab.getByRole("button", { name: copy.conversations.draft.replaceServer }).click();
  await expect(otherTab.getByText(copy.conversations.draft.saved, { exact: true })).toBeVisible();
  await expect(otherDraft).toHaveValue("Reemplazo local confirmado.");
  await otherTab.close();

  await desktopSidebar.getByRole("link", { name: copy.conversations.navigation.search }).click();
  await page.getByLabel(copy.conversations.search.label).fill("BRUJ");
  const alternativeResult = page.getByRole("button", { name: /brújula ámbar/iu });
  await expect(alternativeResult).toBeVisible();
  await alternativeResult.click();
  await expect(page.getByText("La brújula ámbar señala la ruta alternativa.")).toBeVisible();

  await page.getByRole("button", { name: copy.conversations.conversation.rename }).click();
  const renameDialog = page.getByRole("dialog", {
    name: copy.conversations.conversation.renameTitle,
  });
  const titleInput = renameDialog.getByRole("textbox", {
    name: copy.conversations.conversation.titleLabel,
    exact: true,
  });
  await titleInput.fill("Plan de lanzamiento actualizado");
  await renameDialog
    .getByRole("button", { name: copy.conversations.conversation.saveTitle })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Plan de lanzamiento actualizado" }),
  ).toBeVisible();

  await page.getByRole("button", { name: copy.conversations.conversation.archive }).click();
  await expect(
    page.getByRole("button", { name: copy.conversations.conversation.unarchive }),
  ).toBeVisible();
  await desktopSidebar.getByRole("link", { name: copy.conversations.navigation.archived }).click();
  await page.getByRole("link", { name: "Plan de lanzamiento actualizado" }).click();
  await expect(page.getByText(copy.conversations.search.archived, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: copy.conversations.conversation.unarchive }).click();

  await page.getByRole("button", { name: copy.conversations.conversation.delete }).click();
  await expect(page.getByText(copy.conversations.conversation.deleteNotice)).toBeVisible();
  await page.getByRole("button", { name: copy.conversations.conversation.confirmDelete }).click();
  await expect(page.getByRole("heading", { name: copy.conversations.newChat.title })).toBeVisible();
  await expect(page.getByText("Plan de lanzamiento actualizado")).toHaveCount(0);
});
