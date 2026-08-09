import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copy } from "./copy";
import { RootErrorBoundary } from "./root-error-boundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function BrokenPage(): never {
  throw new Error("PRIVATE_RENDER_CANARY");
}

describe("RootErrorBoundary", () => {
  it("preserves a useful Spanish recovery UI and emits only the render kind", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const report = vi.fn();
    const reload = vi.fn();
    const user = userEvent.setup();

    render(
      <RootErrorBoundary reload={reload} reporter={{ report }}>
        <BrokenPage />
      </RootErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: copy.rootFailure.title })).toBeVisible();
    expect(screen.getByText(copy.rootFailure.description)).toBeVisible();
    expect(report).toHaveBeenCalledWith({ kind: "render" });
    expect(JSON.stringify(report.mock.calls)).not.toContain("PRIVATE_RENDER_CANARY");

    const reloadButton = screen.getByRole("button", { name: copy.rootFailure.reload });
    expect(reloadButton).toHaveFocus();
    await user.click(reloadButton);
    expect(reload).toHaveBeenCalledOnce();
  });
});
