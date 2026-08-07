import { SIDEBAR_COLLAPSED_STORAGE_KEY } from "./config";

export function readSidebarCollapsed(storage?: Pick<Storage, "getItem">): boolean {
  try {
    return (storage ?? window.localStorage).getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(
  collapsed: boolean,
  storage?: Pick<Storage, "removeItem" | "setItem">,
): void {
  try {
    const target = storage ?? window.localStorage;
    if (collapsed) {
      target.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "true");
      return;
    }

    target.removeItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
  } catch {
    // A presentation preference must not prevent the authenticated shell from opening.
  }
}
