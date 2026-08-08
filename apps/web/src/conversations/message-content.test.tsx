import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageContent } from "./message-content";

const fallback = "No pudimos mostrar este contenido.";

describe("MessageContent", () => {
  it("renders semantic Markdown, remapped headings, and inert task items", () => {
    render(
      <MessageContent
        fallback={fallback}
        source={`# Principal
###### Menor

Texto con **fuerza**, ~~tachado~~ y \`código\`.

> Una cita

- [x] Listo
- [ ] Pendiente

| Columna | Valor |
| --- | --- |
| Uno | Dos |`}
      />,
    );

    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Principal" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 6, name: "Menor" })).toBeVisible();
    expect(screen.getByText("fuerza").tagName).toBe("STRONG");
    expect(screen.getByText("tachado").tagName).toBe("DEL");
    expect(screen.getByText("Una cita").closest("blockquote")).not.toBeNull();

    const tasks = screen.getAllByRole("checkbox");
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toBeChecked();
    expect(tasks[0]).toBeDisabled();
    expect(tasks[0]).toHaveAttribute("tabindex", "-1");

    const tableRegion = screen.getByRole("table").parentElement;
    expect(tableRegion).toHaveAttribute("data-message-overflow", "table");
    expect(within(screen.getByRole("table")).getByText("Dos")).toBeVisible();
  });

  it("allows only absolute HTTP, HTTPS, and mail links and never mounts media or raw HTML", () => {
    const { container } = render(
      <MessageContent
        fallback={fallback}
        source={`[Seguro](https://example.com/path)
[HTTP](http://example.com)
[Correo](mailto:persona@example.com)
[Relativo](/interno)
[Fragmento](#seccion)
[Datos](data:text/html,hello)
[Archivo](file:///tmp/example)
[Script](javascript:alert(1))

![Imagen remota](https://example.com/tracker.png)

<script>window.bad = true</script>
<iframe src="https://example.com"></iframe>
<img src="https://example.com/raw.png" style="color:red">`}
      />,
    );

    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["Seguro", "HTTP", "Correo"]);
    for (const link of links) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }

    for (const label of ["Relativo", "Fragmento", "Datos", "Archivo", "Script"]) {
      expect(screen.getByText(label).tagName).toBe("SPAN");
    }
    expect(screen.getByText("Imagen remota").tagName).toBe("SPAN");
    expect(container.querySelector("img, script, iframe, object, embed, svg, style")).toBeNull();
    expect(container.querySelector("[style]")).toBeNull();
  });

  it("highlights only approved language labels and leaves other fences plain", () => {
    const { container } = render(
      <MessageContent
        fallback={fallback}
        source={`\`\`\`ts
const answer: number = 42;
\`\`\`

\`\`\`ruby
puts "plain"
\`\`\`

\`\`\`
without_language()
\`\`\``}
      />,
    );

    const blocks = [...container.querySelectorAll("pre code")];
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toHaveClass("hljs", "language-typescript");
    expect(blocks[0]?.querySelector(".hljs-keyword")).not.toBeNull();
    expect(blocks[1]).not.toHaveClass("hljs");
    expect(blocks[1]).toHaveClass("no-highlight");
    expect(blocks[2]).not.toHaveClass("hljs");
  });

  it("registers each approved grammar explicitly", () => {
    const cases = [
      ["javascript", "javascript"],
      ["typescript", "typescript"],
      ["json", "json"],
      ["bash", "bash"],
      ["python", "python"],
      ["sql", "sql"],
      ["css", "css"],
      ["html", "xml"],
      ["markdown", "markdown"],
      ["yaml", "yaml"],
    ] as const;
    const source = cases.map(([label]) => `\`\`\`${label}\nvalue\n\`\`\``).join("\n\n");
    const { container } = render(<MessageContent fallback={fallback} source={source} />);
    const blocks = [...container.querySelectorAll("pre code")];

    expect(blocks).toHaveLength(cases.length);
    for (const [index, [, canonical]] of cases.entries()) {
      expect(blocks[index]).toHaveClass("hljs", `language-${canonical}`);
    }
  });

  it("renders trusted-off MathML without CSS style attributes or unsafe math links", () => {
    const invalidExpression = "\\frac{x";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const renderCodeAction = vi.fn((source: string) => <button type="button">{source}</button>);
    const { container } = render(
      <MessageContent
        fallback={fallback}
        renderCodeAction={renderCodeAction}
        source={`Inline $x^2$.

$$
\\frac{1}{2}
$$

Inválido $\\frac{x$ y no confiable $\\href{https://example.com}{x}$.`}
      />,
    );

    expect(container.querySelectorAll("math")).toHaveLength(3);
    expect(
      container.querySelectorAll("annotation:not([data-message-selection-excluded])"),
    ).toHaveLength(0);
    expect(container.querySelector('math[display="block"]')).not.toBeNull();
    expect(container.querySelector(".katex-html")).toBeNull();
    expect(container.querySelector(".katex-error")).toHaveTextContent(invalidExpression);
    expect(container.querySelector(".katex-error")).not.toHaveAttribute("title");
    expect(
      [...container.querySelectorAll("[title]")].some((element) =>
        element.getAttribute("title")?.includes(invalidExpression),
      ),
    ).toBe(false);
    expect(container.querySelector("[style]")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector('[data-message-overflow="math"]')).not.toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(renderCodeAction).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    warn.mockRestore();
    error.mockRestore();
  });

  it("bounds authored MathML dimensions", () => {
    const { container } = render(
      <MessageContent fallback={fallback} source={"$\\rule{999em}{999em}$"} />,
    );

    const space = container.querySelector("mspace");
    expect(space?.getAttribute("width")).toBe("20em");
    expect(space?.getAttribute("height")).toBe("20em");
  });

  it("provides code actions the exact parsed fence payload", () => {
    const renderCodeAction = vi.fn((source: string) => <button type="button">{source}</button>);
    render(
      <MessageContent
        fallback={fallback}
        renderCodeAction={renderCodeAction}
        source={`\`\`\`python
  primero

\tsegundo 🙂

\`\`\``}
      />,
    );

    expect(renderCodeAction).toHaveBeenCalledOnce();
    expect(renderCodeAction).toHaveBeenCalledWith("  primero\n\n\tsegundo 🙂\n");
    expect(screen.getByRole("button")).toHaveTextContent("primero segundo 🙂");
    expect(screen.getByRole("button").textContent).toBe("  primero\n\n\tsegundo 🙂\n");
  });

  it("adds an accessible name to focusable overflow regions when supplied", () => {
    render(
      <MessageContent
        fallback={fallback}
        overflowLabel="Contenido desplazable"
        source={`| Columna |
| --- |
| Valor |

$$
\\frac{una-expresión-muy-larga}{otra-expresión-muy-larga}
$$

\`\`\`
línea
\`\`\``}
      />,
    );

    const regions = screen.getAllByRole("region", { name: "Contenido desplazable" });
    expect(regions).toHaveLength(3);
    expect(
      regions.find((region) => region.classList.contains("capstone-math-display")),
    ).toHaveAttribute("tabindex", "0");
  });
});
