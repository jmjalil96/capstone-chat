export { lockedAssistantBase as systemPrompt } from "../assistant-rules/prompt.js";

export const continueMessage = Object.freeze({
  text: "Continúa desde donde te detuviste, manteniendo el idioma y el formato de la respuesta anterior.",
  version: "capstone-continue-v1",
});
