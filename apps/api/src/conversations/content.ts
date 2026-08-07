import type { MessageContent } from "@capstone/protocol";
import { ApplicationError } from "../errors.js";
import { conversationCoreTuning } from "./settings.js";

const contentCopy = {
  draftInvalid: "El borrador contiene caracteres no admitidos.",
  draftTooLarge: "El borrador supera el tamaño permitido.",
  invalidStoredContent: "El contenido almacenado de la conversación no es válido.",
  searchInvalid: "Escribe una búsqueda válida.",
  searchTooLarge: "La búsqueda supera el tamaño permitido.",
  titleInvalid: "Escribe un título válido en una sola línea.",
  titleTooLong: "El título supera la longitud permitida.",
} as const;

export function parseMessageContent(value: unknown): MessageContent {
  if (
    !Array.isArray(value) ||
    value.length !== 1 ||
    value[0] === null ||
    typeof value[0] !== "object" ||
    Array.isArray(value[0]) ||
    (value[0] as Record<string, unknown>).type !== "text" ||
    typeof (value[0] as Record<string, unknown>).text !== "string" ||
    Object.keys(value[0] as Record<string, unknown>).some((key) => key !== "type" && key !== "text")
  ) {
    throw new Error(contentCopy.invalidStoredContent);
  }
  return [{ type: "text", text: (value[0] as { text: string }).text }];
}

export function hasUnsupportedControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      ((codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a) ||
        (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

export function normalizeStoredText(value: string): string {
  if (!value.isWellFormed()) {
    throw new ApplicationError(400, "BAD_REQUEST", contentCopy.draftInvalid);
  }
  const normalized = normalizeLineEndings(value);
  if (hasUnsupportedControlCharacter(normalized)) {
    throw new ApplicationError(400, "BAD_REQUEST", contentCopy.draftInvalid);
  }
  return normalized;
}

export function normalizeDraftContent(value: string): string {
  const normalized = normalizeStoredText(value);
  if (utf8Length(normalized) > conversationCoreTuning.draftBytes) {
    throw new ApplicationError(413, "PAYLOAD_TOO_LARGE", contentCopy.draftTooLarge);
  }
  return normalized;
}

export function normalizeManualTitle(value: string): string {
  if (!value.isWellFormed() || /[\r\n\u0085\u2028\u2029]/u.test(value)) {
    throw new ApplicationError(400, "BAD_REQUEST", contentCopy.titleInvalid);
  }
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || hasUnsupportedControlCharacter(normalized)) {
    throw new ApplicationError(400, "BAD_REQUEST", contentCopy.titleInvalid);
  }
  if ([...normalized].length > conversationCoreTuning.manualTitleCodePoints) {
    throw new ApplicationError(400, "BAD_REQUEST", contentCopy.titleTooLong);
  }
  return normalized;
}

export function createInitialTitle(value: string): string {
  if (!value.isWellFormed()) {
    throw new ApplicationError(400, "BAD_REQUEST", contentCopy.titleInvalid);
  }
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  return [...normalized].slice(0, conversationCoreTuning.initialTitleCodePoints).join("");
}

export function normalizeSearchQuery(value: string): string {
  if (!value.isWellFormed()) {
    throw new ApplicationError(400, "BAD_REQUEST", contentCopy.searchInvalid);
  }
  const normalized = value.normalize("NFC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0 || hasUnsupportedControlCharacter(normalized)) {
    throw new ApplicationError(400, "BAD_REQUEST", contentCopy.searchInvalid);
  }
  if (utf8Length(normalized) > conversationCoreTuning.searchQueryBytes) {
    throw new ApplicationError(413, "PAYLOAD_TOO_LARGE", contentCopy.searchTooLarge);
  }
  return normalized;
}

export interface HighlightSegment {
  readonly highlighted: boolean;
  readonly text: string;
}

export interface SearchSnippetSpan {
  readonly endCodePoint: number;
  readonly startCodePoint: number;
}

function isLexemeCharacter(value: string | undefined): boolean {
  return value !== undefined && /^[\p{L}\p{M}\p{N}]$/u.test(value);
}

function codePointBefore(value: string, offset: number): string | undefined {
  if (offset <= 0) {
    return undefined;
  }
  const finalCodeUnit = value.charCodeAt(offset - 1);
  const startsAt =
    finalCodeUnit >= 0xdc00 &&
    finalCodeUnit <= 0xdfff &&
    offset >= 2 &&
    value.charCodeAt(offset - 2) >= 0xd800 &&
    value.charCodeAt(offset - 2) <= 0xdbff
      ? offset - 2
      : offset - 1;
  const codePoint = value.codePointAt(startsAt);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function codePointAt(value: string, offset: number): string | undefined {
  const codePoint = value.codePointAt(offset);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function findNormalizedLexemeMatch(
  normalizedSource: string,
  queryLexemes: readonly string[],
  queryPrefixFlags: readonly boolean[],
): { readonly end: number; readonly start: number } | undefined {
  let firstMatch: { end: number; queryIndex: number; start: number } | undefined;
  for (const [queryIndex, lexeme] of queryLexemes.entries()) {
    const usesPrefix = queryPrefixFlags[queryIndex] === true;
    const requiresStartBoundary = isLexemeCharacter(codePointAt(lexeme, 0));
    const requiresEndBoundary = isLexemeCharacter(codePointBefore(lexeme, lexeme.length));
    let fromIndex = 0;
    while (fromIndex <= normalizedSource.length - lexeme.length) {
      const start = normalizedSource.indexOf(lexeme, fromIndex);
      if (start < 0) {
        break;
      }
      const end = start + lexeme.length;
      if (
        (!requiresStartBoundary || !isLexemeCharacter(codePointBefore(normalizedSource, start))) &&
        (usesPrefix ||
          !requiresEndBoundary ||
          !isLexemeCharacter(codePointAt(normalizedSource, end))) &&
        (firstMatch === undefined ||
          start < firstMatch.start ||
          (start === firstMatch.start && end > firstMatch.end) ||
          (start === firstMatch.start &&
            end === firstMatch.end &&
            queryIndex < firstMatch.queryIndex))
      ) {
        firstMatch = { end, queryIndex, start };
        break;
      }
      fromIndex = start + Math.max(lexeme.length, 1);
    }
  }
  return firstMatch;
}

function mapNormalizedMatchToSource(
  sourceFolds: readonly string[],
  match: { readonly end: number; readonly start: number },
): SearchSnippetSpan | undefined {
  let normalizedOffset = 0;
  let startCodePoint: number | undefined;
  let endCodePoint: number | undefined;
  for (const [index, fold] of sourceFolds.entries()) {
    const foldEnd = normalizedOffset + fold.length;
    if (startCodePoint === undefined && foldEnd > match.start) {
      startCodePoint = index;
    }
    if (startCodePoint !== undefined && foldEnd >= match.end && foldEnd > normalizedOffset) {
      endCodePoint = index + 1;
      break;
    }
    normalizedOffset = foldEnd;
  }
  if (startCodePoint === undefined || endCodePoint === undefined) {
    return undefined;
  }
  while (startCodePoint > 0 && sourceFolds[startCodePoint - 1] === "") {
    startCodePoint -= 1;
  }
  while (endCodePoint < sourceFolds.length && sourceFolds[endCodePoint] === "") {
    endCodePoint += 1;
  }
  return { endCodePoint, startCodePoint };
}

function codePointLength(value: string): number {
  let length = 0;
  for (const _character of value) {
    length += 1;
  }
  return length;
}

function sliceCodePoints(value: string, start: number, end: number): string {
  let codePoint = 0;
  let offset = 0;
  let startOffset = start === 0 ? 0 : value.length;
  let endOffset = value.length;
  for (const character of value) {
    if (codePoint === start) {
      startOffset = offset;
    }
    if (codePoint === end) {
      endOffset = offset;
      break;
    }
    offset += character.length;
    codePoint += 1;
  }
  return value.slice(startOffset, endOffset);
}

function highlightedSegments(
  source: string,
  match: SearchSnippetSpan,
  prefix = "",
  suffix = "",
): HighlightSegment[] {
  const before = `${prefix}${sliceCodePoints(source, 0, match.startCodePoint)}`;
  const highlight = sliceCodePoints(source, match.startCodePoint, match.endCodePoint);
  const after = `${sliceCodePoints(source, match.endCodePoint, codePointLength(source))}${suffix}`;
  return [
    ...(before === "" ? [] : [{ highlighted: false, text: before }]),
    ...(highlight === "" ? [] : [{ highlighted: true, text: highlight }]),
    ...(after === "" ? [] : [{ highlighted: false, text: after }]),
  ];
}

export function createSearchSnippet(
  source: string,
  match: SearchSnippetSpan,
  maximumCodePoints = 160,
): readonly HighlightSegment[] {
  const sourcePointLength = codePointLength(source);
  if (
    !Number.isInteger(match.startCodePoint) ||
    !Number.isInteger(match.endCodePoint) ||
    match.startCodePoint < 0 ||
    match.endCodePoint <= match.startCodePoint ||
    match.endCodePoint > sourcePointLength
  ) {
    throw new Error("Search snippet match is outside the source text");
  }

  if (sourcePointLength <= maximumCodePoints) {
    return highlightedSegments(source, match);
  }

  const contextBefore = Math.floor(maximumCodePoints / 3);
  const start = Math.max(
    0,
    Math.min(match.startCodePoint - contextBefore, sourcePointLength - maximumCodePoints),
  );
  const end = Math.min(sourcePointLength, start + maximumCodePoints);
  const visible = sliceCodePoints(source, start, end);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < sourcePointLength ? "…" : "";
  return highlightedSegments(
    visible,
    {
      endCodePoint: Math.min(match.endCodePoint, end) - start,
      startCodePoint: match.startCodePoint - start,
    },
    prefix,
    suffix,
  );
}

export function createPostgresSearchSnippet(
  source: string,
  sourceFolds: readonly string[],
  queryLexemes: readonly string[],
  queryPrefixFlags: readonly boolean[],
  maximumCodePoints = 160,
): readonly HighlightSegment[] {
  if (
    sourceFolds.length !== codePointLength(source) ||
    queryLexemes.length === 0 ||
    queryPrefixFlags.length !== queryLexemes.length
  ) {
    throw new Error("PostgreSQL search metadata does not match the source text");
  }
  const normalizedMatch = findNormalizedLexemeMatch(
    sourceFolds.join(""),
    queryLexemes,
    queryPrefixFlags,
  );
  const sourceMatch =
    normalizedMatch === undefined
      ? undefined
      : mapNormalizedMatchToSource(sourceFolds, normalizedMatch);
  if (sourceMatch === undefined) {
    throw new Error("PostgreSQL search metadata contains no source match");
  }
  return createSearchSnippet(source, sourceMatch, maximumCodePoints);
}
