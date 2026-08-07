import { describe, expect, it } from "vitest";
import {
  createEmailSender,
  DisabledEmailSender,
  FakeEmailSender,
  type IdentityEmail,
} from "../src/identity/email.js";
import { normalizeApprovalEmail, normalizeEmail } from "../src/identity/email-normalization.js";
import {
  createInvitationEmail,
  createPasswordResetEmail,
  createVerificationEmail,
} from "../src/identity/email-templates.js";

describe("normalizeEmail", () => {
  it("trims, NFC-normalizes, and lowercases an approval address", () => {
    expect(normalizeEmail(" \tJOSE\u0301.PEN\u0303A@EXAMPLE.COM\n")).toBe(
      "jos\u00e9.pe\u00f1a@example.com",
    );
  });

  it("is deterministic when an address is already canonical", () => {
    const canonical = "empleada@capstone.example";

    expect(normalizeEmail(normalizeEmail(canonical))).toBe(canonical);
  });

  it("validates operator approval addresses after canonicalization", () => {
    expect(normalizeApprovalEmail("  EMPLOYEE@EXAMPLE.TEST ")).toBe("employee@example.test");
    expect(() => normalizeApprovalEmail("not-an-email")).toThrow(
      "Employee email must be a valid email address",
    );
  });
});

describe("Spanish identity email templates", () => {
  it("creates the employee invitation without putting identity data in the link", () => {
    const email = createInvitationEmail(
      "empleada@capstone.example",
      "http://localhost:5173/sign-up",
    );

    expect(email).toEqual({
      purpose: "invitation",
      subject: "Tu acceso a Capstone Chat",
      text: [
        "Tu acceso a Capstone Chat fue aprobado.",
        "",
        "Crea tu cuenta en http://localhost:5173/sign-up",
        "",
        "El enlace no inicia sesi\u00f3n ni contiene una credencial. Usar\u00e1s este correo y elegir\u00e1s tu contrase\u00f1a.",
      ].join("\n"),
      to: "empleada@capstone.example",
    });
    expect(email.text).not.toContain("empleada@capstone.example");
    expect(Object.isFrozen(email)).toBe(true);
  });

  it("passes the Better Auth verification URL through unchanged", () => {
    const verificationUrl =
      "http://localhost:5173/api/auth/verify-email?token=verification-secret&callbackURL=%2F";
    const email = createVerificationEmail("empleada@capstone.example", verificationUrl);

    expect(email).toEqual({
      purpose: "verification",
      subject: "Verifica tu correo de Capstone Chat",
      text: [
        "Confirma que este correo te pertenece para activar tu acceso a Capstone Chat.",
        "",
        verificationUrl,
        "",
        "Si no creaste esta cuenta, puedes ignorar este mensaje.",
      ].join("\n"),
      to: "empleada@capstone.example",
    });
    expect(Object.isFrozen(email)).toBe(true);
  });

  it("passes the Better Auth password-reset URL through unchanged", () => {
    const resetUrl = "http://localhost:5173/reset-password?token=reset-secret";
    const email = createPasswordResetEmail("empleada@capstone.example", resetUrl);

    expect(email).toEqual({
      purpose: "password-reset",
      subject: "Restablece tu contrase\u00f1a de Capstone Chat",
      text: [
        "Recibimos una solicitud para restablecer tu contrase\u00f1a de Capstone Chat.",
        "",
        resetUrl,
        "",
        "Si no hiciste esta solicitud, puedes ignorar este mensaje.",
      ].join("\n"),
      to: "empleada@capstone.example",
    });
    expect(Object.isFrozen(email)).toBe(true);
  });
});

function message(subject: string): IdentityEmail {
  return {
    purpose: "invitation",
    subject,
    text: `Contenido ${subject}`,
    to: "empleada@capstone.example",
  };
}

describe("FakeEmailSender", () => {
  it("retains only the newest messages up to its configured bound", async () => {
    const sender = new FakeEmailSender(2);

    await sender.send(message("Primero"));
    await sender.send(message("Segundo"));
    await sender.send(message("Tercero"));

    const deliveries = sender.deliveries();
    expect(deliveries.map((delivery) => delivery.subject)).toEqual(["Segundo", "Tercero"]);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.every((delivery) => Object.isFrozen(delivery))).toBe(true);
    expect(deliveries.every((delivery) => delivery.id.length > 0)).toBe(true);
    expect(deliveries.every((delivery) => !Number.isNaN(Date.parse(delivery.createdAt)))).toBe(
      true,
    );
  });

  it("returns defensive delivery records", async () => {
    const sender = new FakeEmailSender(1);
    await sender.send(message("Entrega"));

    const firstRead = sender.deliveries();
    const secondRead = sender.deliveries();

    expect(firstRead).toEqual(secondRead);
    expect(firstRead[0]).not.toBe(secondRead[0]);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects an invalid retention bound: %s", (retention) => {
    expect(() => new FakeEmailSender(retention)).toThrow(
      "Fake email retention must be a positive integer",
    );
  });
});

describe("disabled email delivery", () => {
  it("fails explicitly instead of pretending a message was delivered", async () => {
    const sender = new DisabledEmailSender();

    expect(sender.kind).toBe("disabled");
    await expect(sender.send(message("No enviada"))).rejects.toThrow(
      "Transactional email delivery is not configured",
    );
  });

  it("selects only the configured fake or disabled implementation", () => {
    expect(createEmailSender("fake")).toBeInstanceOf(FakeEmailSender);
    expect(createEmailSender("disabled")).toBeInstanceOf(DisabledEmailSender);
  });
});
