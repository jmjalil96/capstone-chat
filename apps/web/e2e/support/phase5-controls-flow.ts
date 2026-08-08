import { expect, type Page } from "@playwright/test";

import { copy } from "../../src/copy";
import { openDesktopConversation, phaseFiveBrowserFixtures } from "./phase5-fixture";

const simulatedResponse = "Esta es una respuesta simulada de Capstone Chat para desarrollo local.";

export async function exerciseConversationControls(page: Page, projectName: string): Promise<void> {
  const title = Object.entries(phaseFiveBrowserFixtures.controlsTitles).find(
    ([project]) => project === projectName,
  )?.[1];
  if (!title) {
    throw new Error(`No control fixture exists for ${projectName}`);
  }

  await page.setViewportSize({ width: 1_280, height: 800 });
  await openDesktopConversation(page, title);
  const draft = page.getByRole("textbox", { name: copy.conversations.draft.label });
  await expect(draft).toHaveValue(phaseFiveBrowserFixtures.controlsDraft);

  const firstAnswer = page
    .locator(".message-assistant")
    .filter({ hasText: "Primera respuesta preservada." });
  const nextAlternative = firstAnswer.getByRole("button", {
    name: copy.conversations.messages.nextAlternative,
  });
  await expect(nextAlternative).toBeEnabled();
  await nextAlternative.click();
  await expect(
    page.getByText(phaseFiveBrowserFixtures.controlsNextBranchText, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(phaseFiveBrowserFixtures.controlsOriginalBranchText, { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(copy.conversations.messages.branchSelected, { exact: true }),
  ).toBeVisible();

  const secondAnswer = page
    .locator(".message-assistant")
    .filter({ hasText: "Segunda respuesta preservada." });
  const previousAlternative = secondAnswer.getByRole("button", {
    name: copy.conversations.messages.previousAlternative,
  });
  await expect(previousAlternative).toBeEnabled();
  await previousAlternative.click();
  await expect(
    page.getByText(phaseFiveBrowserFixtures.controlsOriginalBranchText, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(phaseFiveBrowserFixtures.controlsNextBranchText, { exact: true }),
  ).toHaveCount(0);

  const selectedLeaf = page
    .locator(".message-assistant")
    .filter({ hasText: phaseFiveBrowserFixtures.controlsOriginalBranchText });
  await selectedLeaf.getByRole("button", { name: copy.conversations.messages.undo }).click();
  await expect(
    page.getByText(phaseFiveBrowserFixtures.controlsOriginalBranchText, { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Primera respuesta preservada.", { exact: true })).toBeVisible();
  await expect(
    page.getByText(copy.conversations.messages.turnUndone, { exact: true }),
  ).toBeVisible();
  await expect(draft).toHaveValue(phaseFiveBrowserFixtures.controlsDraft);

  const rootMessage = page
    .locator(".message-user")
    .filter({ hasText: phaseFiveBrowserFixtures.controlsOriginalRoot });
  const rootMessageId = await rootMessage.getAttribute("data-message-id");
  if (!rootMessageId) {
    throw new Error("The selected control branch has no root user identifier");
  }
  const rootMessageById = page.locator(`[data-message-id="${rootMessageId}"]`);
  await rootMessage.getByRole("button", { name: copy.conversations.messages.edit }).click();
  const editor = rootMessageById.getByRole("textbox", {
    name: copy.conversations.messages.editLabel,
  });
  await editor.fill("Primera línea");
  await editor.press("Enter");
  await editor.type("Segunda línea");
  await expect(editor).toHaveValue("Primera línea\nSegunda línea");
  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(draft).toHaveValue(phaseFiveBrowserFixtures.controlsDraft);

  await rootMessageById.getByRole("button", { name: copy.conversations.messages.edit }).click();
  const committedEditor = rootMessageById.getByRole("textbox", {
    name: copy.conversations.messages.editLabel,
  });
  await committedEditor.fill(phaseFiveBrowserFixtures.controlsEditedRoot);
  await rootMessageById.getByRole("button", { name: copy.conversations.messages.saveEdit }).click();
  await expect(
    page.getByText(phaseFiveBrowserFixtures.controlsEditedRoot, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(phaseFiveBrowserFixtures.controlsOriginalRoot, { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(simulatedResponse, { exact: true })).toBeVisible();
  await expect(draft).toHaveValue(phaseFiveBrowserFixtures.controlsDraft);

  const editedAnswer = page.locator(".message-assistant").filter({ hasText: simulatedResponse });
  await editedAnswer.getByRole("button", { name: copy.conversations.messages.tryAgain }).click();
  await expect(page.getByText(simulatedResponse, { exact: true })).toBeVisible();
  const retriedAnswer = page.locator(".message-assistant").filter({ hasText: simulatedResponse });
  await expect(retriedAnswer.getByText("2 / 2", { exact: true })).toBeVisible();
  await expect(
    page.locator(".message-user").filter({ hasText: phaseFiveBrowserFixtures.controlsEditedRoot }),
  ).toHaveCount(1);
  await expect(draft).toHaveValue(phaseFiveBrowserFixtures.controlsDraft);

  await page.reload();
  await expect(
    page.getByText(phaseFiveBrowserFixtures.controlsEditedRoot, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(simulatedResponse, { exact: true })).toBeVisible();
  await expect(draft).toHaveValue(phaseFiveBrowserFixtures.controlsDraft);

  await page.getByRole("button", { name: copy.conversations.conversation.archive }).click();
  await expect(
    page.getByRole("button", { name: copy.conversations.conversation.unarchive }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: copy.conversations.messages.copyAnswer }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: copy.conversations.messages.tryAgain }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: copy.conversations.messages.edit })).toHaveCount(0);
  const archivedSelectedAnswer = page
    .locator(".message-assistant")
    .filter({ hasText: simulatedResponse });
  await expect(
    archivedSelectedAnswer.getByRole("button", {
      name: copy.conversations.messages.previousAlternative,
    }),
  ).toBeEnabled();
}
