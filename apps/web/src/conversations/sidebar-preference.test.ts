import { describe, expect, it, vi } from "vitest";

import { SIDEBAR_COLLAPSED_STORAGE_KEY } from "./config";
import { readSidebarCollapsed, writeSidebarCollapsed } from "./sidebar-preference";

describe("sidebar preference", () => {
  it("uses only the approved presentation key", () => {
    const storage = {
      getItem: vi.fn().mockReturnValue("true"),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    };

    expect(readSidebarCollapsed(storage)).toBe(true);
    expect(storage.getItem).toHaveBeenCalledWith(SIDEBAR_COLLAPSED_STORAGE_KEY);

    writeSidebarCollapsed(true, storage);
    expect(storage.setItem).toHaveBeenCalledWith(SIDEBAR_COLLAPSED_STORAGE_KEY, "true");

    writeSidebarCollapsed(false, storage);
    expect(storage.removeItem).toHaveBeenCalledWith(SIDEBAR_COLLAPSED_STORAGE_KEY);
  });

  it("fails soft when browser preference storage is unavailable", () => {
    const unavailableStorage = {
      getItem: vi.fn(() => {
        throw new DOMException("Blocked", "SecurityError");
      }),
      removeItem: vi.fn(() => {
        throw new DOMException("Blocked", "SecurityError");
      }),
      setItem: vi.fn(() => {
        throw new DOMException("Blocked", "SecurityError");
      }),
    };

    expect(readSidebarCollapsed(unavailableStorage)).toBe(false);
    expect(() => writeSidebarCollapsed(true, unavailableStorage)).not.toThrow();
    expect(() => writeSidebarCollapsed(false, unavailableStorage)).not.toThrow();
  });
});
