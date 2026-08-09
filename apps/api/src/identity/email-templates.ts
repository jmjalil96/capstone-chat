import type { IdentityEmail } from "./email.js";

const brand = Object.freeze({
  action: "#007265",
  background: "#f7f7f4",
  border: "#d9dfe1",
  ink: "#0c2939",
  muted: "#5b6b74",
  surface: "#ffffff",
});

interface TemplateBody {
  readonly actionLabel: string;
  readonly actionUrl: string;
  readonly footer: string;
  readonly heading: string;
  readonly introduction: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function html(body: TemplateBody): string {
  const actionUrl = escapeHtml(body.actionUrl);
  return [
    '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    `<body style="margin:0;background:${brand.background};color:${brand.ink};font-family:Arial,sans-serif">`,
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${brand.background};padding:32px 16px"><tr><td align="center">`,
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:${brand.surface};border:1px solid ${brand.border};border-radius:10px"><tr><td style="padding:36px">`,
    `<p style="margin:0 0 24px;color:${brand.action};font-size:14px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">Capstone Chat</p>`,
    `<h1 style="margin:0 0 16px;font-size:28px;line-height:1.2">${escapeHtml(body.heading)}</h1>`,
    `<p style="margin:0 0 24px;font-size:17px;line-height:1.55">${escapeHtml(body.introduction)}</p>`,
    `<p style="margin:0 0 28px"><a href="${actionUrl}" style="display:inline-block;background:${brand.action};border-radius:6px;color:#ffffff;padding:13px 20px;text-decoration:none;font-weight:700">${escapeHtml(body.actionLabel)}</a></p>`,
    `<p style="margin:0;color:${brand.muted};font-size:14px;line-height:1.5">${escapeHtml(body.footer)}</p>`,
    "</td></tr></table></td></tr></table></body></html>",
  ].join("");
}

function credentialActionUrl(publicOrigin: string, path: string, token: string): string {
  if (token.length === 0) {
    throw new Error("Identity email credential is missing");
  }

  let origin: URL;
  try {
    origin = new URL(publicOrigin);
  } catch {
    throw new Error("Identity email public origin is invalid");
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("Identity email public origin is invalid");
  }

  const actionUrl = new URL(path, origin.origin);
  actionUrl.hash = new URLSearchParams({ token }).toString();
  return actionUrl.href;
}

export function createInvitationEmail(to: string, signUpUrl: string): IdentityEmail {
  const body = {
    actionLabel: "Crear mi cuenta",
    actionUrl: signUpUrl,
    footer:
      "El enlace no inicia sesión ni contiene una credencial. Usarás este correo y elegirás tu contraseña.",
    heading: "Tu acceso fue aprobado",
    introduction: "Ya puedes crear tu cuenta de Capstone Chat.",
  } satisfies TemplateBody;

  return Object.freeze({
    html: html(body),
    purpose: "invitation",
    subject: "Tu acceso a Capstone Chat",
    text: [
      "Tu acceso a Capstone Chat fue aprobado.",
      "",
      `Crea tu cuenta en ${signUpUrl}`,
      "",
      body.footer,
    ].join("\n"),
    to,
  });
}

export function createVerificationEmail(
  to: string,
  publicOrigin: string,
  token: string,
): IdentityEmail {
  const actionUrl = credentialActionUrl(publicOrigin, "/verify-email", token);
  const body = {
    actionLabel: "Verificar mi correo",
    actionUrl,
    footer: "Si no creaste esta cuenta, puedes ignorar este mensaje.",
    heading: "Verifica tu correo",
    introduction: "Confirma que este correo te pertenece para activar tu acceso a Capstone Chat.",
  } satisfies TemplateBody;

  return Object.freeze({
    html: html(body),
    purpose: "verification",
    subject: "Verifica tu correo de Capstone Chat",
    text: [body.introduction, "", actionUrl, "", body.footer].join("\n"),
    to,
  });
}

export function createPasswordResetEmail(
  to: string,
  publicOrigin: string,
  token: string,
): IdentityEmail {
  const actionUrl = credentialActionUrl(publicOrigin, "/reset-password", token);
  const body = {
    actionLabel: "Restablecer mi contraseña",
    actionUrl,
    footer: "Si no hiciste esta solicitud, puedes ignorar este mensaje.",
    heading: "Restablece tu contraseña",
    introduction: "Recibimos una solicitud para restablecer tu contraseña de Capstone Chat.",
  } satisfies TemplateBody;

  return Object.freeze({
    html: html(body),
    purpose: "password-reset",
    subject: "Restablece tu contraseña de Capstone Chat",
    text: [body.introduction, "", actionUrl, "", body.footer].join("\n"),
    to,
  });
}
