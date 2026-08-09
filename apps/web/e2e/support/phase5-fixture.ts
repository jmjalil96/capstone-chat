import { createHmac } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";

import {
  conversationBrowserAuthentication,
  conversationBrowserEmployee,
  phaseFiveBrowserFixtures,
  responseGalleryAssistantMarkdown,
  responseGalleryTypeScriptCode,
} from "../../../api/tests/support/conversation-e2e-fixtures";
import { copy } from "../../src/copy";

export {
  phaseFiveBrowserFixtures,
  responseGalleryAssistantMarkdown,
  responseGalleryTypeScriptCode,
};

interface ClipboardCaptureState {
  readonly writes: string[];
}

const clipboardCaptures = new WeakMap<Page, ClipboardCaptureState>();

export async function installClipboardCapture(page: Page): Promise<void> {
  const state: ClipboardCaptureState = { writes: [] };
  clipboardCaptures.set(page, state);
  await page.exposeFunction("__capstoneE2eWriteClipboard", (text: string) => {
    state.writes.push(text);
  });
  await page.addInitScript(() => {
    Object.defineProperty(window, "__capstoneE2eRejectClipboard", {
      configurable: true,
      value: false,
      writable: true,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText(text: string) {
          const bridge = window as unknown as {
            __capstoneE2eRejectClipboard: boolean;
            __capstoneE2eWriteClipboard(value: string): Promise<void>;
          };
          return bridge.__capstoneE2eRejectClipboard
            ? Promise.reject(new DOMException("Clipboard denied", "NotAllowedError"))
            : bridge.__capstoneE2eWriteClipboard(text);
        },
      },
    });
  });
}

export async function clipboardWrites(page: Page): Promise<string[]> {
  return [...(clipboardCaptures.get(page)?.writes ?? [])];
}

export async function rejectClipboardWrites(page: Page): Promise<void> {
  if (!clipboardCaptures.has(page)) {
    throw new Error("Clipboard capture was not installed for this browser page");
  }
  await page.evaluate(() => {
    (
      window as unknown as {
        __capstoneE2eRejectClipboard: boolean;
      }
    ).__capstoneE2eRejectClipboard = true;
  });
}

async function openConversationSidebar(page: Page, isMobile: boolean): Promise<Locator> {
  if (!isMobile) {
    const sidebar = page.locator(".desktop-sidebar");
    await expect(sidebar).toBeVisible();
    return sidebar;
  }

  await page.getByRole("button", { name: copy.conversations.navigation.open }).click();
  const drawer = page.getByRole("dialog", { name: copy.conversations.navigation.label });
  await expect(drawer).toBeVisible();
  return drawer;
}

export async function openAuthenticatedBrowserEmployee(
  page: Page,
  isMobile = false,
): Promise<void> {
  const signature = createHmac("sha256", conversationBrowserAuthentication.secret)
    .update(conversationBrowserAuthentication.sessionToken)
    .digest("base64");
  await page.context().addCookies([
    {
      domain: "127.0.0.1",
      httpOnly: true,
      name: "better-auth.session_token",
      path: "/",
      sameSite: "Lax",
      secure: false,
      value: encodeURIComponent(`${conversationBrowserAuthentication.sessionToken}.${signature}`),
    },
  ]);
  const sessionReady = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/session" && response.status() === 200,
  );
  await page.goto("/");
  await sessionReady;
  await page.getByRole("heading", { level: 1, name: copy.conversations.newChat.title }).waitFor();
  const sidebar = await openConversationSidebar(page, isMobile);
  await sidebar.getByLabel(copy.conversations.navigation.account).waitFor();
  await sidebar.getByText(conversationBrowserEmployee.name, { exact: true }).waitFor();
  if (isMobile) {
    await sidebar.getByRole("button", { name: copy.conversations.navigation.close }).click();
    await expect(sidebar).not.toBeVisible();
  }
  await page.waitForLoadState("networkidle");
}

export async function followConversationSidebarLink(
  page: Page,
  name: string,
  isMobile: boolean,
): Promise<void> {
  const sidebar = await openConversationSidebar(page, isMobile);
  await sidebar.getByRole("link", { name }).click();
  if (isMobile) {
    await expect(sidebar).not.toBeVisible();
  }
}

export async function openConversation(
  page: Page,
  title: string,
  isMobile: boolean,
): Promise<void> {
  await followConversationSidebarLink(page, title, isMobile);
  await page.getByRole("heading", { level: 1, name: title }).waitFor();
}

export async function openDesktopConversation(page: Page, title: string): Promise<void> {
  await openConversation(page, title, false);
}
