import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-markdown", async () => {
  const actual = await vi.importActual<typeof import("react-markdown")>("react-markdown");

  return {
    ...actual,
    default: ({ children }: { readonly children?: string | null }) => {
      if (children === "marcador-confidencial") {
        throw new Error("Renderer failed");
      }

      return <p>{children}</p>;
    },
  };
});

import { MessageContent } from "./message-content";

describe("MessageContent renderer boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows only its supplied fallback and retries when streaming source changes", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { rerender } = render(
      <MessageContent
        fallback="No pudimos mostrar este contenido."
        source="marcador-confidencial"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("No pudimos mostrar este contenido.");
    expect(screen.queryByText("marcador-confidencial")).not.toBeInTheDocument();
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("marcador-confidencial");

    rerender(
      <MessageContent
        fallback="No pudimos mostrar este contenido."
        source="contenido recuperado"
      />,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("contenido recuperado")).toBeVisible();
  });
});
