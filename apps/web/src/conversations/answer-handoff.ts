import { isSafeMessageDestination } from "./link-safety";

const HANDOFF_ALLOWED_ELEMENTS = new Set([
  "A",
  "BLOCKQUOTE",
  "BR",
  "CODE",
  "DEL",
  "EM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "LI",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SPAN",
  "STRONG",
  "SUB",
  "SUP",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

const HANDOFF_REMOVED_ELEMENTS = new Set([
  "AUDIO",
  "BUTTON",
  "CANVAS",
  "EMBED",
  "FORM",
  "IFRAME",
  "IMG",
  "OBJECT",
  "OPTION",
  "SCRIPT",
  "SELECT",
  "SOURCE",
  "STYLE",
  "SVG",
  "TEMPLATE",
  "TEXTAREA",
  "VIDEO",
]);

const HANDOFF_BLOCK_ELEMENTS = new Set([
  "BLOCKQUOTE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "UL",
]);

const FORMULA_PREFIX = /^[=+\-@]/u;

export interface AnswerHandoffSnapshot {
  readonly element: HTMLElement;
  readonly html: string;
  readonly text: string;
}

function replaceElementTag(element: HTMLElement, tagName: string): HTMLElement {
  const replacement = element.ownerDocument.createElement(tagName);
  replacement.append(...element.childNodes);
  element.replaceWith(replacement);
  return replacement;
}

function prepareAuthoredHeadings(root: HTMLElement): void {
  for (const heading of root.querySelectorAll<HTMLElement>("[data-message-heading-level]")) {
    const level = Number(heading.dataset.messageHeadingLevel);
    if (Number.isInteger(level) && level >= 1 && level <= 6) {
      replaceElementTag(heading, `h${level}`);
    }
  }
}

function prepareTaskStates(root: HTMLElement): void {
  for (const input of root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    input.replaceWith(input.ownerDocument.createTextNode(input.checked ? "[x] " : "[ ] "));
  }
}

function prepareMathematics(root: HTMLElement): void {
  for (const mathRoot of root.querySelectorAll<HTMLElement>('[data-message-overflow="math"]')) {
    const source = mathRoot.querySelector("annotation")?.textContent ?? mathRoot.textContent ?? "";
    const display = mathRoot.querySelector('math[display="block"]') !== null;
    const replacement = mathRoot.ownerDocument.createElement(display ? "p" : "span");
    replacement.textContent = source;
    mathRoot.replaceWith(replacement);
  }
}

function unwrap(element: Element): void {
  element.replaceWith(...element.childNodes);
}

function sanitizeElement(element: HTMLElement): void {
  for (const child of [...element.children]) {
    if (!(child instanceof HTMLElement)) {
      child.remove();
      continue;
    }
    if (HANDOFF_REMOVED_ELEMENTS.has(child.tagName)) {
      child.remove();
      continue;
    }

    if (!HANDOFF_ALLOWED_ELEMENTS.has(child.tagName)) {
      sanitizeElement(child);
      unwrap(child);
      continue;
    }

    sanitizeElement(child);
  }

  if (element.tagName === "A") {
    const href = element.getAttribute("href") ?? undefined;
    if (!isSafeMessageDestination(href)) {
      unwrap(element);
      return;
    }
    for (const attribute of [...element.attributes]) {
      if (attribute.name !== "href") {
        element.removeAttribute(attribute.name);
      }
    }
    return;
  }

  if (element.tagName === "OL") {
    const rawStart = element.getAttribute("start");
    const start = rawStart === null ? 1 : Number(rawStart);
    for (const attribute of [...element.attributes]) {
      element.removeAttribute(attribute.name);
    }
    if (Number.isSafeInteger(start) && Math.abs(start) <= 1_000_000 && start !== 1) {
      element.setAttribute("start", String(start));
    }
    return;
  }

  for (const attribute of [...element.attributes]) {
    element.removeAttribute(attribute.name);
  }
}

function normalizedInlineWhitespace(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/\u00a0/gu, " ")
    .replace(/[\t\f\v ]+/gu, " ")
    .replace(/ *\n */gu, "\n");
}

function readableInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.nodeValue ?? "";
  }
  if (!(node instanceof HTMLElement)) {
    return "";
  }
  if (node.tagName === "BR") {
    return "\n";
  }
  if (node.tagName === "A") {
    const label = normalizedInlineWhitespace(
      [...node.childNodes].map(readableInline).join(""),
    ).trim();
    const href = node.getAttribute("href") ?? "";
    return label === href || label === href.replace(/^mailto:/u, "") ? label : `${label} (${href})`;
  }

  return [...node.childNodes].map(readableInline).join("");
}

function normalizeBlock(value: string): string {
  return normalizedInlineWhitespace(value)
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function serializeMixedNodes(nodes: readonly Node[]): string {
  const blocks: string[] = [];
  let inline = "";

  const flushInline = () => {
    const value = normalizeBlock(inline);
    if (value) {
      blocks.push(value);
    }
    inline = "";
  };

  for (const node of nodes) {
    if (node instanceof HTMLElement && HANDOFF_BLOCK_ELEMENTS.has(node.tagName)) {
      flushInline();
      const value = readableBlock(node);
      if (value) {
        blocks.push(value);
      }
    } else {
      inline += readableInline(node);
    }
  }
  flushInline();
  return blocks.join("\n\n");
}

function serializeList(list: HTMLOListElement | HTMLUListElement, depth = 0): string {
  const ordered = list instanceof HTMLOListElement;
  const start = ordered ? list.start : 1;
  const lines: string[] = [];
  const items = [...list.children].filter(
    (child): child is HTMLLIElement => child instanceof HTMLLIElement,
  );

  for (const [index, item] of items.entries()) {
    const nested = [...item.children].filter(
      (child): child is HTMLOListElement | HTMLUListElement =>
        child instanceof HTMLOListElement || child instanceof HTMLUListElement,
    );
    const nestedNodes = new Set<Node>(nested);
    const content = serializeMixedNodes(
      [...item.childNodes].filter((node) => !nestedNodes.has(node)),
    );
    const prefix = ordered ? `${start + index}. ` : "- ";
    const indentation = "  ".repeat(depth);
    const continuation = `${indentation}${" ".repeat(prefix.length)}`;
    const contentLines = (content || " ").split("\n");
    lines.push(`${indentation}${prefix}${contentLines[0] ?? ""}`.trimEnd());
    for (const line of contentLines.slice(1)) {
      lines.push(`${continuation}${line}`.trimEnd());
    }
    for (const childList of nested) {
      lines.push(serializeList(childList, depth + 1));
    }
  }

  return lines.join("\n");
}

function readableBlock(element: HTMLElement): string {
  if (element instanceof HTMLTableElement) {
    return answerTableToTsv(element);
  }
  if (element instanceof HTMLOListElement || element instanceof HTMLUListElement) {
    return serializeList(element);
  }
  if (element.tagName === "PRE") {
    return (element.textContent ?? "").replace(/\r\n?/gu, "\n").replace(/\n$/u, "");
  }
  if (element.tagName === "BLOCKQUOTE") {
    return serializeMixedNodes([...element.childNodes])
      .split("\n")
      .map((line) => `> ${line}`.trimEnd())
      .join("\n");
  }
  if (element.tagName === "HR") {
    return "────────";
  }
  if (element.tagName === "SECTION") {
    return serializeMixedNodes([...element.childNodes]);
  }
  return normalizeBlock([...element.childNodes].map(readableInline).join(""));
}

export function answerTableToTsv(table: HTMLTableElement): string {
  return [...table.rows]
    .map((row) =>
      [...row.cells]
        .map((cell) => {
          const value = normalizedInlineWhitespace(
            [...cell.childNodes].map(readableInline).join(""),
          )
            .replace(/\n+/gu, " ")
            .trim();
          return FORMULA_PREFIX.test(value) ? `'${value}` : value;
        })
        .join("\t"),
    )
    .join("\n");
}

export function createAnswerHandoffSnapshot(renderedRoot: HTMLElement): AnswerHandoffSnapshot {
  const element = renderedRoot.cloneNode(true) as HTMLElement;
  for (const excluded of element.querySelectorAll("[data-message-handoff-excluded]")) {
    excluded.remove();
  }
  prepareAuthoredHeadings(element);
  prepareTaskStates(element);
  prepareMathematics(element);
  for (const excluded of element.querySelectorAll("[data-message-selection-excluded]")) {
    excluded.remove();
  }
  sanitizeElement(element);

  return {
    element,
    html: element.innerHTML,
    text: serializeMixedNodes([...element.childNodes]),
  };
}
