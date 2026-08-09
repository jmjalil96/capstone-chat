import { describe, expect, it, vi } from "vitest";
import {
  createEmailSender,
  DisabledEmailSender,
  dispatchIdentityEmail,
  FakeEmailSender,
  type IdentityEmail,
} from "../src/identity/email.js";
import { normalizeApprovalEmail, normalizeEmail } from "../src/identity/email-normalization.js";
import {
  createInvitationEmail,
  createPasswordResetEmail,
  createVerificationEmail,
} from "../src/identity/email-templates.js";
import { type EmailDeliveryReport, ResendEmailSender } from "../src/identity/resend-email.js";

const publicOrigin = "https://chat.capstone.com.ec";
const providerMessageId = "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794";
const firstIdempotencyKey = "08a4c6c8-493c-4bb7-b6ce-dac6280458dd";
const secondIdempotencyKey = "07d246b2-ae65-4dfb-a20e-69ae99e17db6";

function successResponse(): Response {
  return new Response(JSON.stringify({ id: providerMessageId }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

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
  it("creates an escaped HTML and text invitation without identity data in the link", () => {
    const signUpUrl = 'https://chat.capstone.com.ec/sign-up?next=%3Cprofile%3E&label="invite"';
    const email = createInvitationEmail("empleada@capstone.example", signUpUrl);

    expect(email.purpose).toBe("invitation");
    expect(email.subject).toBe("Tu acceso a Capstone Chat");
    expect(email.text).toContain(`Crea tu cuenta en ${signUpUrl}`);
    expect(email.text).not.toContain("empleada@capstone.example");
    expect(email.html).toContain('lang="es"');
    expect(email.html).toContain("Crear mi cuenta");
    expect(email.html).toContain("&amp;label=&quot;invite&quot;");
    expect(email.html).not.toContain('&label="invite"');
    expect(email.html).not.toContain("empleada@capstone.example");
    expect(Object.isFrozen(email)).toBe(true);
  });

  it.each([
    {
      create: createVerificationEmail,
      path: "/verify-email",
      purpose: "verification",
      token: 'verification-secret<&"',
    },
    {
      create: createPasswordResetEmail,
      path: "/reset-password",
      purpose: "password-reset",
      token: "reset-secret",
    },
  ])("puts the $purpose credential only in a browser fragment", (fixture) => {
    const email = fixture.create("empleada@capstone.example", publicOrigin, fixture.token);
    const action = email.text.split("\n").find((line) => line.startsWith("https://"));
    if (action === undefined) {
      throw new Error("The template did not contain an action URL");
    }
    const actionUrl = new URL(action);

    expect(actionUrl.origin).toBe(publicOrigin);
    expect(actionUrl.pathname).toBe(fixture.path);
    expect(actionUrl.search).toBe("");
    expect(new URLSearchParams(actionUrl.hash.slice(1)).get("token")).toBe(fixture.token);
    expect(actionUrl.pathname).not.toContain(fixture.token);
    expect(email.html).toContain(`href="${action.replaceAll("&", "&amp;")}"`);
    expect(email.html).not.toContain("<script");
    expect(Object.isFrozen(email)).toBe(true);
  });
});

function message(subject: string): IdentityEmail {
  return {
    html: `<p>${subject}</p>`,
    purpose: "invitation",
    subject,
    text: `Contenido ${subject}`,
    to: "empleada@capstone.example",
  };
}

describe("FakeEmailSender", () => {
  it("retains complete defensive messages up to its configured bound", async () => {
    const sender = new FakeEmailSender(2);
    await sender.send(message("Primero"));
    await sender.send(message("Segundo"));
    await sender.send(message("Tercero"));

    const deliveries = sender.deliveries();
    expect(deliveries.map((delivery) => delivery.subject)).toEqual(["Segundo", "Tercero"]);
    expect(deliveries[1]?.html).toBe("<p>Tercero</p>");
    expect(deliveries.every((delivery) => Object.isFrozen(delivery))).toBe(true);
    expect(deliveries.every((delivery) => delivery.id.length > 0)).toBe(true);
    expect(sender.deliveries()[0]).not.toBe(deliveries[0]);
    await sender.close();
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

  it("selects configured implementations without a silent fallback", () => {
    expect(createEmailSender("fake")).toBeInstanceOf(FakeEmailSender);
    expect(createEmailSender("disabled")).toBeInstanceOf(DisabledEmailSender);
    expect(() => createEmailSender("resend")).toThrow("Resend API key is required");
    expect(
      createEmailSender("resend", {
        emailFrom: "Capstone Chat <no-reply@mail.capstone.com.ec>",
        resendApiKey: "re_test_only",
      }),
    ).toBeInstanceOf(ResendEmailSender);
  });
});

describe("ResendEmailSender", () => {
  it("sends the exact bounded native-fetch contract and reports safe metadata", async () => {
    const reports: EmailDeliveryReport[] = [];
    const transport = vi.fn<typeof fetch>(async () => successResponse());
    const sender = new ResendEmailSender({
      apiKey: "re_test_only",
      fetch: transport,
      from: "Capstone Chat <no-reply@mail.capstone.com.ec>",
      idempotencyKey: () => firstIdempotencyKey,
      now: (() => {
        const values = [100, 112];
        return () => values.shift() ?? 112;
      })(),
      onDeliveryReport: (report) => reports.push(report),
    });
    const email = message("Invitación");

    await sender.send(email);

    expect(transport).toHaveBeenCalledOnce();
    const [input, init] = transport.mock.calls[0] ?? [];
    expect(input).toBe("https://api.resend.com/emails");
    expect(init).toMatchObject({ method: "POST" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer re_test_only");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("user-agent")).toBe("Capstone-Chat/1.0");
    expect(headers.get("idempotency-key")).toBe(firstIdempotencyKey);
    expect(JSON.parse(String(init?.body))).toEqual({
      from: "Capstone Chat <no-reply@mail.capstone.com.ec>",
      html: email.html,
      subject: email.subject,
      text: email.text,
      to: [email.to],
    });
    expect(reports).toEqual([{ durationMs: 12, outcome: "sent", providerStatus: 200 }]);
  });

  it("uses a new UUID for each deliberate invocation and performs no automatic retry", async () => {
    const keys = [firstIdempotencyKey, secondIdempotencyKey];
    const transport = vi.fn<typeof fetch>(async () => successResponse());
    const sender = new ResendEmailSender({
      apiKey: "re_test_only",
      fetch: transport,
      from: "Capstone Chat <no-reply@mail.capstone.com.ec>",
      idempotencyKey: () => keys.shift() ?? secondIdempotencyKey,
    });

    await sender.send(message("Primera"));
    await sender.send(message("Reenvío deliberado"));

    expect(transport).toHaveBeenCalledTimes(2);
    expect(
      transport.mock.calls.map(([, init]) => new Headers(init?.headers).get("idempotency-key")),
    ).toEqual([firstIdempotencyKey, secondIdempotencyKey]);
  });

  it.each([
    { category: "authentication", status: 401 },
    { category: "authentication", status: 403 },
    { category: "provider", status: 400 },
    { category: "rate_limit", status: 429 },
    { category: "provider", status: 500 },
  ] as const)("sanitizes a $status response as $category", async ({ category, status }) => {
    const responseBody = "provider-detail-containing-a-secret";
    const sender = new ResendEmailSender({
      apiKey: "re_test_only",
      fetch: async () => new Response(responseBody, { status }),
      from: "Capstone Chat <no-reply@mail.capstone.com.ec>",
    });

    const failure = await sender
      .send(
        createVerificationEmail(
          "private-recipient@example.test",
          publicOrigin,
          "private-verification-token",
        ),
      )
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      category,
      message: "Transactional email delivery failed",
      name: "ResendEmailError",
      providerStatus: status,
    });
    const serializedFailure = JSON.stringify(failure);
    for (const secret of [
      responseBody,
      "private-recipient@example.test",
      "private-verification-token",
      publicOrigin,
    ]) {
      expect(serializedFailure).not.toContain(secret);
    }
  });

  it.each([
    ["empty", new Response("", { headers: { "content-type": "application/json" }, status: 200 })],
    [
      "malformed",
      new Response("not-json", { headers: { "content-type": "application/json" }, status: 200 }),
    ],
    [
      "wrong content type",
      new Response(JSON.stringify({ id: providerMessageId }), { status: 200 }),
    ],
    [
      "deceptive content type",
      new Response(JSON.stringify({ id: providerMessageId }), {
        headers: { "content-type": "application/json-seq" },
        status: 200,
      }),
    ],
    [
      "invalid id",
      new Response(JSON.stringify({ id: "provider prose" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    ],
    [
      "unexpected response field",
      new Response(JSON.stringify({ id: providerMessageId, recipient: "private@example.test" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    ],
    [
      "oversized declared body",
      new Response(JSON.stringify({ id: providerMessageId }), {
        headers: { "content-length": "9000", "content-type": "application/json" },
        status: 200,
      }),
    ],
    [
      "oversized streamed body",
      new Response("x".repeat(9_000), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    ],
  ])("rejects a bounded %s success response", async (_label, response) => {
    const sender = new ResendEmailSender({
      apiKey: "re_test_only",
      fetch: async () => response.clone(),
      from: "Capstone Chat <no-reply@mail.capstone.com.ec>",
    });

    await expect(sender.send(message("Respuesta inválida"))).rejects.toMatchObject({
      category: "provider",
      name: "ResendEmailError",
      providerStatus: 200,
    });
  });

  it("maps network and timeout failures without retaining their details", async () => {
    const networkSender = new ResendEmailSender({
      apiKey: "re_test_only",
      fetch: async () => {
        throw new Error("dns detail and secret");
      },
      from: "Capstone Chat <no-reply@mail.capstone.com.ec>",
    });
    await expect(networkSender.send(message("Red"))).rejects.toMatchObject({
      category: "network",
      message: "Transactional email delivery failed",
    });

    const timeoutSender = new ResendEmailSender({
      apiKey: "re_test_only",
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted secret")), {
            once: true,
          });
        }),
      from: "Capstone Chat <no-reply@mail.capstone.com.ec>",
      timeoutMilliseconds: 5,
    });
    await expect(timeoutSender.send(message("Lenta"))).rejects.toMatchObject({
      category: "timeout",
      message: "Transactional email delivery failed",
    });

    const stalledBodySender = new ResendEmailSender({
      apiKey: "re_test_only",
      fetch: async () =>
        new Response(new ReadableStream<Uint8Array>({}), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      from: "Capstone Chat <no-reply@mail.capstone.com.ec>",
      timeoutMilliseconds: 5,
    });
    await expect(stalledBodySender.send(message("Cuerpo lento"))).rejects.toMatchObject({
      category: "timeout",
      message: "Transactional email delivery failed",
      providerStatus: 200,
    });
  });

  it("owns public non-awaited work until it settles", async () => {
    const failure = vi.fn();
    const sender = new ResendEmailSender({
      apiKey: "re_test_only",
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
      from: "Capstone Chat <no-reply@mail.capstone.com.ec>",
      timeoutMilliseconds: 5,
    });

    dispatchIdentityEmail(sender, message("Pública"), failure);
    expect(failure).not.toHaveBeenCalled();
    await sender.close();
    expect(failure).toHaveBeenCalledWith("invitation", "ResendEmailError");
    await expect(sender.send(message("Después del cierre"))).rejects.toThrow("shutting down");
  });

  it("drains a tracked provider request before aborting shutdown", async () => {
    const providerRequest = Promise.withResolvers<Response>();
    let requestSignal: AbortSignal | null | undefined;
    const sender = new ResendEmailSender({
      apiKey: "re_test_only",
      fetch: async (_input, init) => {
        requestSignal = init?.signal;
        return providerRequest.promise;
      },
      from: "Capstone Chat <no-reply@mail.capstone.com.ec>",
    });
    const delivery = sender.send(message("Durante el cierre"));
    const closing = sender.close();

    providerRequest.resolve(successResponse());
    await expect(delivery).resolves.toBeUndefined();
    await expect(closing).resolves.toBeUndefined();
    expect(requestSignal?.aborted).toBe(false);
  });

  it("boundedly aborts provider work that does not finish during shutdown drain", async () => {
    vi.useFakeTimers();
    try {
      const sender = new ResendEmailSender({
        apiKey: "re_test_only",
        fetch: async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
        from: "Capstone Chat <no-reply@mail.capstone.com.ec>",
      });
      const delivery = sender.send(message("Pendiente")).catch((error: unknown) => error);
      const closing = sender.close();

      await vi.advanceTimersByTimeAsync(1_000);
      await closing;

      await expect(delivery).resolves.toMatchObject({
        category: "unknown",
        name: "ResendEmailError",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
