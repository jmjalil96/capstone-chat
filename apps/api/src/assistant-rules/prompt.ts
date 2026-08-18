import {
  ASSISTANT_RULES_MAX_CODE_POINTS,
  ASSISTANT_RULES_MAX_UTF8_BYTES,
  type AssistantRulesCounts,
} from "@capstone/protocol";

function hasUnsupportedControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x08 ||
        codePoint === 0x0b ||
        codePoint === 0x0c ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

export const lockedAssistantBase = Object.freeze({
  text: [
    "REGLAS BASE DE CAPSTONE CHAT — OBLIGATORIAS Y PREVALECEN ANTE CUALQUIER CONFLICTO",
    "",
    "- Eres Capstone Chat, el asistente de IA para empleados de Capstone.",
    "- Responde en Markdown compatible con Capstone Chat. No emitas HTML sin procesar.",
    "- Sé útil, preciso y directo, y respeta el formato solicitado.",
    "- No afirmes que realizaste acciones ni que accediste a sistemas, cuentas, archivos, sitios,",
    "  herramientas o información fuera de lo incluido explícitamente en esta conversación.",
    "- No inventes fuentes, citas, cifras ni hechos. Distingue con claridad lo conocido, lo inferido y",
    "  lo incierto; cuando no puedas verificar algo, dilo.",
    "- Responde en el idioma de la solicitud más reciente, salvo que la persona pida explícitamente",
    "  otro idioma.",
  ].join("\n"),
  version: "capstone-chat-base-v2",
});

export const workspaceAssistantHeading = "CONTEXTO Y REGLAS DEL ESPACIO DE TRABAJO — EDITABLES";
export const emptyWorkspaceAssistantRulesMarker = "Sin reglas adicionales.";

export interface SystemPromptSnapshot {
  readonly baseVersion: typeof lockedAssistantBase.version;
  readonly workspaceRevision: number;
  readonly text: string;
}

export class InvalidAssistantRulesError extends Error {
  readonly reason:
    | "invalid_unicode"
    | "unsupported_control"
    | "too_many_code_points"
    | "too_many_bytes";

  constructor(reason: InvalidAssistantRulesError["reason"], message: string) {
    super(message);
    this.name = "InvalidAssistantRulesError";
    this.reason = reason;
  }
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new InvalidAssistantRulesError(
          "invalid_unicode",
          "Workspace assistant rules must be well-formed Unicode",
        );
      }
      index += 1;
      continue;
    }
    if (current >= 0xdc00 && current <= 0xdfff) {
      throw new InvalidAssistantRulesError(
        "invalid_unicode",
        "Workspace assistant rules must be well-formed Unicode",
      );
    }
  }
}

export function assistantRulesCounts(normalizedWorkspaceText: string): AssistantRulesCounts {
  const utf8Bytes = Buffer.byteLength(normalizedWorkspaceText, "utf8");
  return Object.freeze({
    approximateInputTokens: Math.ceil(utf8Bytes / 4),
    codePoints: [...normalizedWorkspaceText].length,
    utf8Bytes,
  });
}

export function normalizeWorkspaceAssistantRules(value: string): string {
  assertWellFormedUnicode(value);
  const normalized = value.normalize("NFC").replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  if (hasUnsupportedControlCharacter(normalized)) {
    throw new InvalidAssistantRulesError(
      "unsupported_control",
      "Workspace assistant rules contain an unsupported control character",
    );
  }
  const counts = assistantRulesCounts(normalized);
  if (counts.codePoints > ASSISTANT_RULES_MAX_CODE_POINTS) {
    throw new InvalidAssistantRulesError(
      "too_many_code_points",
      "Workspace assistant rules exceed the code-point limit",
    );
  }
  if (counts.utf8Bytes > ASSISTANT_RULES_MAX_UTF8_BYTES) {
    throw new InvalidAssistantRulesError(
      "too_many_bytes",
      "Workspace assistant rules exceed the UTF-8 byte limit",
    );
  }
  return normalized;
}

export function composeAssistantSystemPrompt(normalizedWorkspaceText: string): string {
  const editable = normalizedWorkspaceText || emptyWorkspaceAssistantRulesMarker;
  return `${workspaceAssistantHeading}\n\n${editable}\n\n${lockedAssistantBase.text}`;
}

export function createSystemPromptSnapshot(
  workspaceRevision: number,
  normalizedWorkspaceText: string,
): SystemPromptSnapshot {
  if (!Number.isInteger(workspaceRevision) || workspaceRevision <= 0) {
    throw new Error("Workspace assistant prompt revision must be a positive integer");
  }
  return Object.freeze({
    baseVersion: lockedAssistantBase.version,
    workspaceRevision,
    text: composeAssistantSystemPrompt(normalizedWorkspaceText),
  });
}
