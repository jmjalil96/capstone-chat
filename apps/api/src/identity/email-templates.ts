import type { IdentityEmail } from "./email.js";

export function createInvitationEmail(to: string, signUpUrl: string): IdentityEmail {
  return Object.freeze({
    purpose: "invitation",
    subject: "Tu acceso a Capstone Chat",
    text: [
      "Tu acceso a Capstone Chat fue aprobado.",
      "",
      `Crea tu cuenta en ${signUpUrl}`,
      "",
      "El enlace no inicia sesión ni contiene una credencial. Usarás este correo y elegirás tu contraseña.",
    ].join("\n"),
    to,
  });
}

export function createVerificationEmail(to: string, verificationUrl: string): IdentityEmail {
  return Object.freeze({
    purpose: "verification",
    subject: "Verifica tu correo de Capstone Chat",
    text: [
      "Confirma que este correo te pertenece para activar tu acceso a Capstone Chat.",
      "",
      verificationUrl,
      "",
      "Si no creaste esta cuenta, puedes ignorar este mensaje.",
    ].join("\n"),
    to,
  });
}

export function createPasswordResetEmail(to: string, resetUrl: string): IdentityEmail {
  return Object.freeze({
    purpose: "password-reset",
    subject: "Restablece tu contraseña de Capstone Chat",
    text: [
      "Recibimos una solicitud para restablecer tu contraseña de Capstone Chat.",
      "",
      resetUrl,
      "",
      "Si no hiciste esta solicitud, puedes ignorar este mensaje.",
    ].join("\n"),
    to,
  });
}
