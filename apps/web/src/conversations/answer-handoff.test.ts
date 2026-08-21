import { afterEach, describe, expect, it, vi } from "vitest";
import { startTextDownload } from "./answer-download";
import {
  type AnswerHandoffSnapshot,
  answerTableToTsv,
  createAnswerHandoffSnapshot,
} from "./answer-handoff";
import { startAnswerPrint } from "./answer-print";

function renderedAnswer(markup: string): HTMLElement {
  const root = document.createElement("div");
  root.dataset.messageContent = "";
  root.innerHTML = markup;
  document.body.append(root);
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("answer handoff serialization", () => {
  it("creates allowlisted semantic HTML and deterministic readable text", () => {
    const root = renderedAnswer(`
      <h2 class="visual-heading" data-message-heading-level="1" onclick="bad()">Título</h2>
      <p>Texto <strong style="color:red">fuerte</strong> y <a href="https://example.com/reporte" target="_blank" onclick="bad()">Fuente</a>.</p>
      <p><a href="javascript:alert(1)">Inseguro</a></p>
      <ul class="contains-task-list"><li><input type="checkbox" checked>Hecho</li></ul>
      <div data-message-handoff-excluded><button type="button">Copiar código</button></div>
      <table><thead><tr><th>Nombre</th><th>Valor</th></tr></thead>
        <tbody><tr><td>Dato</td><td>=SUM(A1:A2)</td></tr></tbody></table>
      <pre class="highlight"><code>const dato = 1;</code></pre>
      <img src="https://tracker.invalid/pixel.png" alt="Rastreo">
    `);

    const snapshot = createAnswerHandoffSnapshot(root);

    expect(snapshot.html).toContain("<h1>Título</h1>");
    expect(snapshot.html).toContain('<a href="https://example.com/reporte">Fuente</a>');
    expect(snapshot.html).toContain("<strong>fuerte</strong>");
    expect(snapshot.html).toContain("<p>Inseguro</p>");
    expect(snapshot.html).not.toMatch(
      /class=|style=|onclick=|target=|data-message|javascript:|<button|<input|<img/u,
    );
    expect(snapshot.text).toBe(
      [
        "Título",
        "Texto fuerte y Fuente (https://example.com/reporte).",
        "Inseguro",
        "- [x] Hecho",
        "Nombre\tValor\nDato\t'=SUM(A1:A2)",
        "const dato = 1;",
      ].join("\n\n"),
    );
  });

  it("preserves list numbering, visible link destinations, code, and table structure", () => {
    const root = renderedAnswer(`
      <ol start="3"><li>Primero<ul><li>Anidado</li></ul></li><li>Segundo</li></ol>
      <ol><li>Predeterminado</li></ol>
      <blockquote>Consulta <a href="mailto:equipo@example.com">equipo</a></blockquote>
      <pre><code>línea 1\nlínea 2\n</code></pre>
    `);

    const snapshot = createAnswerHandoffSnapshot(root);

    expect(snapshot.text).toBe(
      [
        "3. Primero\n  - Anidado\n4. Segundo",
        "1. Predeterminado",
        "> Consulta equipo (mailto:equipo@example.com)",
        "línea 1\nlínea 2",
      ].join("\n\n"),
    );
    expect(snapshot.html).toContain('<ol start="3">');
    expect(snapshot.html).not.toContain('<ol start="0">');
  });

  it("represents renderer mathematics once as authored TeX", () => {
    const root = renderedAnswer(`
      <p>Identidad <span data-message-overflow="math"><math><semantics><mi>x</mi>
        <annotation encoding="application/x-tex">x^2 + y</annotation></semantics></math></span>.</p>
      <span data-message-overflow="math"><math display="block"><semantics><mi>z</mi>
        <annotation encoding="application/x-tex">z = 42</annotation></semantics></math></span>
    `);

    const snapshot = createAnswerHandoffSnapshot(root);

    expect(snapshot.html).toContain("<span>x^2 + y</span>");
    expect(snapshot.html).toContain("<p>z = 42</p>");
    expect(snapshot.html).not.toMatch(/<math|<annotation|data-message/u);
    expect(snapshot.text).toBe("Identidad x^2 + y.\n\nz = 42");
  });
});

describe("table handoff", () => {
  it("normalizes cells and prefixes every spreadsheet formula trigger", () => {
    const root = renderedAnswer(`
      <table><tbody>
        <tr><td> =SUM(A1:A2)</td><td>+1</td><td>-2</td><td>@cmd</td></tr>
        <tr><td>Texto\tcon\nespacios</td><td>42</td><td></td><td>Seguro</td></tr>
      </tbody></table>
    `);
    const table = root.querySelector("table");
    if (!(table instanceof HTMLTableElement)) {
      throw new Error("Table fixture did not render");
    }

    expect(answerTableToTsv(table)).toBe(
      "'=SUM(A1:A2)\t'+1\t'-2\t'@cmd\nTexto con espacios\t42\t\tSeguro",
    );
  });
});

describe("local answer files", () => {
  it("downloads exact UTF-8 contents without a byte-order mark and revokes the URL", async () => {
    let downloadedFilename: string | undefined;
    let downloadedUrl: string | undefined;
    let downloadedBlob: Blob | undefined;
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloadedFilename = this.download;
      downloadedUrl = this.href;
    });

    startTextDownload("área\nexacta", "respuesta-capstone-chat.txt", "text/plain;charset=utf-8", {
      document,
      createObjectURL: (blob) => {
        downloadedBlob = blob;
        return "blob:capstone-answer";
      },
      revokeObjectURL,
      scheduleCleanup: (callback) => callback(),
    });

    expect(click).toHaveBeenCalledOnce();
    expect(downloadedFilename).toBe("respuesta-capstone-chat.txt");
    expect(downloadedUrl).toBe("blob:capstone-answer");
    expect(downloadedBlob?.type).toBe("text/plain;charset=utf-8");
    await expect(downloadedBlob?.text()).resolves.toBe("área\nexacta");
    expect(await downloadedBlob?.arrayBuffer()).toEqual(
      new TextEncoder().encode("área\nexacta").buffer,
    );
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:capstone-answer");
    expect(document.querySelector('a[download="respuesta-capstone-chat.txt"]')).toBeNull();
  });
});

describe("answer printing", () => {
  function printEnvironment({ throws = false }: { readonly throws?: boolean } = {}) {
    let animationCallback: FrameRequestCallback | undefined;
    const listeners = new Map<string, EventListener>();
    const print = vi.fn(() => {
      if (throws) {
        throw new Error("print unavailable");
      }
      listeners.get("afterprint")?.(new Event("afterprint"));
    });
    const fakeWindow = {
      addEventListener: (name: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === "function") {
          listeners.set(name, listener);
        }
      },
      cancelAnimationFrame: vi.fn(),
      clearTimeout: vi.fn(),
      matchMedia: undefined,
      print,
      removeEventListener: (name: string) => listeners.delete(name),
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        animationCallback = callback;
        return 7;
      },
      setTimeout: vi.fn(() => 9),
    } as unknown as Window;
    return {
      animation: () => animationCallback?.(0),
      environment: { document, window: fakeWindow },
      print,
    };
  }

  it("prints only the selected answer with a generic header and terminal warning", () => {
    const answer = document.createElement("div");
    answer.innerHTML = "<h1>Resultado</h1><p>Contenido privado</p>";
    const snapshot: AnswerHandoffSnapshot = {
      element: answer,
      html: answer.innerHTML,
      text: "Resultado\n\nContenido privado",
    };
    const onFailure = vi.fn();
    const { animation, environment, print } = printEnvironment();

    startAnswerPrint(snapshot, "Respuesta incompleta", onFailure, environment);

    const printRoot = document.querySelector<HTMLElement>(".answer-print-root");
    expect(document.body).toHaveAttribute("data-answer-printing");
    expect(printRoot).toHaveTextContent("Capstone Chat");
    expect(printRoot).toHaveTextContent("Respuesta");
    expect(printRoot).toHaveTextContent("Resultado");
    expect(printRoot).toHaveTextContent("Respuesta incompleta");
    expect(printRoot).not.toHaveTextContent("Título de conversación");

    animation();

    expect(print).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
    expect(document.querySelector(".answer-print-root")).toBeNull();
    expect(document.body).not.toHaveAttribute("data-answer-printing");
  });

  it("cleans up and reports a synchronous print failure", () => {
    const answer = document.createElement("div");
    answer.textContent = "Respuesta";
    const snapshot: AnswerHandoffSnapshot = {
      element: answer,
      html: "Respuesta",
      text: "Respuesta",
    };
    const onFailure = vi.fn();
    const { animation, environment } = printEnvironment({ throws: true });

    startAnswerPrint(snapshot, undefined, onFailure, environment);
    animation();

    expect(onFailure).toHaveBeenCalledOnce();
    expect(document.querySelector(".answer-print-root")).toBeNull();
    expect(document.body).not.toHaveAttribute("data-answer-printing");
  });
});
