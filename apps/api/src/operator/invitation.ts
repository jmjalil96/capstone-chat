import type { EmailSender } from "../identity/email.js";
import { createInvitationEmail } from "../identity/email-templates.js";
import { ResendEmailError } from "../identity/resend-email.js";

export function invitationDeliveryFailureMetadata(
  error: unknown,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    errorName: error instanceof Error ? error.name : "UnknownError",
    ...(error instanceof ResendEmailError
      ? {
          category: error.category,
          durationMs: error.durationMs,
          ...(error.providerStatus === undefined ? {} : { providerStatus: error.providerStatus }),
        }
      : {}),
    outcome: "approval-committed",
    retrySafe: true,
  });
}

export async function sendInvitationEmail(
  sender: EmailSender,
  publicOrigin: string,
  normalizedEmail: string,
): Promise<void> {
  const signUpUrl = new URL("/sign-up", publicOrigin).href;
  await sender.send(createInvitationEmail(normalizedEmail, signUpUrl));
}
