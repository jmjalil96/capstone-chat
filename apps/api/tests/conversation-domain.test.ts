import { describe, expect, it } from "vitest";
import {
  createInitialTitle,
  createPostgresSearchSnippet,
  createSearchSnippet,
  normalizeDraftContent,
  normalizeManualTitle,
  normalizeSearchQuery,
} from "../src/conversations/content.js";
import { createCursorCodec } from "../src/conversations/cursor.js";
import { conversationCoreTuning } from "../src/conversations/settings.js";
import { ApplicationError } from "../src/errors.js";

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ApplicationError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code}`);
}

function snippetSpan(source: string, text: string, fromIndex = 0) {
  const start = source.indexOf(text, fromIndex);
  if (start < 0) {
    throw new Error(`Missing snippet text: ${text}`);
  }
  return {
    endCodePoint: [...source.slice(0, start + text.length)].length,
    startCodePoint: [...source.slice(0, start)].length,
  };
}

describe("conversation core tuning", () => {
  it("locks the selected Phase 3 backend values", () => {
    expect(conversationCoreTuning).toEqual({
      branchMessagePageSize: 40,
      draftBytes: 32_768,
      draftRequestBodyBytes: 67_584,
      historyPageSize: 20,
      initialTitleCodePoints: 72,
      manualTitleCodePoints: 120,
      searchPageSize: 20,
      searchQueryBytes: 256,
    });
    expect(Object.isFrozen(conversationCoreTuning)).toBe(true);
  });
});

describe("conversation text boundaries", () => {
  it("builds deterministic initial titles without splitting a Unicode code point", () => {
    const source = `  Primera\n\tconsulta   ${"🧭".repeat(80)}  `;
    const title = createInitialTitle(source);

    expect(title.startsWith("Primera consulta ")).toBe(true);
    expect([...title]).toHaveLength(72);
    expect(title.endsWith("\ud83e")).toBe(false);
  });

  it("normalizes manual titles to one non-empty display line", () => {
    expect(normalizeManualTitle("  Informe\t  sintético  ")).toBe("Informe sintético");
    for (const lineBreak of ["\r", "\n", "\u0085", "\u2028", "\u2029"]) {
      expectCode(() => normalizeManualTitle(`Informe${lineBreak}sintético`), "BAD_REQUEST");
    }
    expectCode(() => normalizeManualTitle(" \n\t "), "BAD_REQUEST");
    expectCode(() => normalizeManualTitle("x".repeat(121)), "BAD_REQUEST");
  });

  it("normalizes only draft line endings and preserves supported whitespace", () => {
    expect(normalizeDraftContent("  uno\r\n\tdos\r  ")).toBe("  uno\n\tdos\n  ");
    expectCode(() => normalizeDraftContent("texto\u0000oculto"), "BAD_REQUEST");
    expectCode(() => normalizeDraftContent("texto\ud800inválido"), "BAD_REQUEST");
    expectCode(() => normalizeDraftContent("ñ".repeat(16_385)), "PAYLOAD_TOO_LARGE");
  });

  it("enforces the exact UTF-8 search bound after canonical normalization", () => {
    expect(normalizeSearchQuery("  ÁRBOL   Azul ")).toBe("árbol azul");
    expectCode(() => normalizeSearchQuery("  \t "), "BAD_REQUEST");
    expectCode(() => normalizeSearchQuery("ñ".repeat(129)), "PAYLOAD_TOO_LARGE");
  });

  it("creates plain typed snippets and highlights punctuation-derived lexemes", () => {
    const source = "Alpha beta segura";
    expect(createSearchSnippet(source, snippetSpan(source, "beta"))).toEqual([
      { highlighted: false, text: "Alpha " },
      { highlighted: true, text: "beta" },
      { highlighted: false, text: " segura" },
    ]);
    const longSource = `${"inicio ".repeat(40)}objetivo${" final".repeat(40)}`;
    const long = createSearchSnippet(longSource, snippetSpan(longSource, "objetivo"));
    expect(long.some((segment) => segment.highlighted && segment.text === "objetivo")).toBe(true);
    expect(long.map((segment) => segment.text).join("").length).toBeLessThan(170);
  });

  it("maps folded search positions back to decomposed Unicode text", () => {
    const source = "Cafe\u0301 previo y bru\u0301jula segura";
    const segments = createSearchSnippet(source, snippetSpan(source, "bru\u0301jula"));

    expect(segments).toEqual([
      { highlighted: false, text: "Cafe\u0301 previo y " },
      { highlighted: true, text: "bru\u0301jula" },
      { highlighted: false, text: " segura" },
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(source);
  });

  it("renders bounded database-derived spans without splitting Unicode", () => {
    const source = `${"relleno ".repeat(30)}Æther Straße smør Łódź beta eta final`;
    const cases = ["Æther", "Straße", "smør", "Łódź", "eta"] as const;

    for (const expectedHighlight of cases) {
      const segments = createSearchSnippet(source, snippetSpan(source, expectedHighlight));
      expect(segments.find((segment) => segment.highlighted)?.text).toBe(expectedHighlight);
      expect(segments.map((segment) => segment.text).join("")).toContain(expectedHighlight);
    }
  });

  it("maps authoritative folds at token boundaries and across removed marks", () => {
    const source = "foobarbaz foo-bar baz \u0301luz cafe\u0301 Æther";
    const folds = [...source].map((character) => {
      if (character === "\u0301") {
        return "";
      }
      return character === "Æ" ? "ae" : character.toLocaleLowerCase("und");
    });

    const bar = createPostgresSearchSnippet(source, folds, ["bar"], [true]);
    const barIndex = bar.findIndex((segment) => segment.highlighted);
    expect(bar[barIndex]?.text).toBe("bar");
    expect(
      bar
        .slice(0, barIndex)
        .map((segment) => segment.text)
        .join("")
        .endsWith("foo-"),
    ).toBe(true);

    const baz = createPostgresSearchSnippet(source, folds, ["baz"], [true]);
    const bazIndex = baz.findIndex((segment) => segment.highlighted);
    expect(baz[bazIndex]?.text).toBe("baz");
    expect(
      baz
        .slice(0, bazIndex)
        .map((segment) => segment.text)
        .join("")
        .endsWith("foo-bar "),
    ).toBe(true);
    expect(
      createPostgresSearchSnippet(source, folds, ["luz"], [true]).find(
        (segment) => segment.highlighted,
      )?.text,
    ).toBe("\u0301luz");
    expect(
      createPostgresSearchSnippet(source, folds, ["cafe"], [true]).find(
        (segment) => segment.highlighted,
      )?.text,
    ).toBe("cafe\u0301");
    expect(
      createPostgresSearchSnippet(source, folds, ["aet"], [true]).find(
        (segment) => segment.highlighted,
      )?.text,
    ).toBe("Æt");

    const underscoreSource = "foo_bar";
    expect(
      createPostgresSearchSnippet(underscoreSource, [...underscoreSource], ["bar"], [true]).find(
        (segment) => segment.highlighted,
      )?.text,
    ).toBe("bar");
    const urlSource = "https://example.com/a-b?q=x";
    expect(
      createPostgresSearchSnippet(urlSource, [...urlSource], ["/a-b"], [true]).find(
        (segment) => segment.highlighted,
      )?.text,
    ).toBe("/a-b");
    expect(
      createPostgresSearchSnippet(
        "foo-bar",
        [..."foo-bar"],
        ["foo", "ba", "foo-ba"],
        [true, true, true],
      ).find((segment) => segment.highlighted)?.text,
    ).toBe("foo-ba");
  });
});

describe("opaque cursor codec", () => {
  const codec = createCursorCodec("phase-three-test-secret-longer-than-thirty-two-characters");

  it("round-trips a signed route-bound cursor", () => {
    const cursor = codec.encode({ id: "synthetic", kind: "history", version: 1 });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(codec.decode(cursor, "history")).toEqual({
      id: "synthetic",
      kind: "history",
      version: 1,
    });
  });

  it("rejects tampering and cross-route reuse", () => {
    const cursor = codec.encode({ id: "synthetic", kind: "history", version: 1 });
    expectCode(() => codec.decode(`${cursor.slice(0, -1)}A`, "history"), "INVALID_CURSOR");
    expectCode(() => codec.decode(cursor, "search"), "INVALID_CURSOR");
  });
});
