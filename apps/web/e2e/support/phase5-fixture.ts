import { createHmac } from "node:crypto";
import type { Page } from "@playwright/test";

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

export async function openAuthenticatedBrowserEmployee(page: Page): Promise<void> {
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
  await page
    .locator(".desktop-sidebar")
    .getByLabel(copy.conversations.navigation.account)
    .waitFor();
  await page
    .locator(".desktop-sidebar")
    .getByText(conversationBrowserEmployee.name, { exact: true })
    .waitFor();
  await page.waitForLoadState("networkidle");
}

export async function openDesktopConversation(page: Page, title: string): Promise<void> {
  await page.locator(".desktop-sidebar").getByRole("link", { name: title }).click();
  await page.getByRole("heading", { level: 1, name: title }).waitFor();
}
