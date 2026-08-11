import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  loadConfig,
  loadDatabaseConfig,
  loadIdentityOperatorConfig,
  loadOpenRouterOperatorConfig,
  loadRecoveryPreparationOperatorConfig,
  publicConfigMetadata,
} from "../src/config.js";
import { loadSecretEnvironment } from "../src/secret-environment.js";

const productionEnvironment = {
  BETTER_AUTH_SECRET: "production-auth-secret-with-at-least-thirty-two-characters",
  CLIENT_ADDRESS_SOURCE: "caddy",
  DATABASE_URL: "postgresql://app:secret@database.internal:5432/capstone?sslmode=verify-full",
  DEPLOYMENT_REVISION: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  EMAIL_DELIVERY: "resend",
  EMAIL_FROM: "Capstone Chat <no-reply@mail.capstone.com.ec>",
  HOST: "127.0.0.1",
  MODEL_GATEWAY: "openrouter",
  NODE_ENV: "production",
  OPENROUTER_API_KEY: "test-openrouter-key-never-sent",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.nr-data.net",
  OTEL_EXPORTER_OTLP_HEADERS: "api-key=test-license-key-never-sent",
  PUBLIC_ORIGIN: "https://chat.capstone.com.ec",
  RESEND_API_KEY: "test-resend-key-never-sent",
} satisfies NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("rejects direct process-environment credentials in production", () => {
    const keys = [...Object.keys(productionEnvironment), "CAPSTONE_SECRET_FILE"];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, productionEnvironment);
      delete process.env.CAPSTONE_SECRET_FILE;

      expect(() => loadConfig()).toThrow("CAPSTONE_SECRET_FILE");
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  it("accepts production process credentials only after strict file loading", () => {
    const directory = mkdtempSync(join(tmpdir(), "capstone-production-config-"));
    const secretPath = join(directory, "runtime.json");
    const secretKeys = [
      "BETTER_AUTH_SECRET",
      "DATABASE_URL",
      "OPENROUTER_API_KEY",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "RESEND_API_KEY",
    ] as const;
    writeFileSync(
      secretPath,
      JSON.stringify(
        Object.fromEntries(secretKeys.map((key) => [key, productionEnvironment[key]])),
      ),
      { mode: 0o600 },
    );
    chmodSync(secretPath, 0o440);
    const keys = [...Object.keys(productionEnvironment), "CAPSTONE_SECRET_FILE"];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      for (const key of secretKeys) {
        delete process.env[key];
      }
      for (const [key, value] of Object.entries(productionEnvironment)) {
        if (!secretKeys.includes(key as (typeof secretKeys)[number])) {
          process.env[key] = value;
        }
      }
      process.env.CAPSTONE_SECRET_FILE = secretPath;
      loadSecretEnvironment(process.env, { expectedOwnerUserId: process.getuid?.() ?? 0 });

      expect(loadConfig().nodeEnv).toBe("production");
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("returns frozen development defaults", () => {
    const config = loadConfig({});

    expect(config).toEqual({
      authSecret: "capstone-chat-local-auth-secret-not-for-production-use",
      clientAddressSource: "socket",
      databaseUrl: "postgresql://capstone:capstone@127.0.0.1:5432/capstone_chat",
      deploymentRevision: "development",
      emailDelivery: "fake",
      emailFrom: null,
      host: "127.0.0.1",
      logLevel: "info",
      modelGateway: "fake",
      nodeEnv: "development",
      openRouterApiKey: null,
      otlpEndpoint: null,
      otlpHeaders: {},
      port: 3000,
      publicOrigin: "http://localhost:5173",
      resendApiKey: null,
      trustProxy: false,
      webAssetsDirectory: null,
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.otlpHeaders)).toBe(true);
  });

  it("accepts explicit test configuration", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://tester:tester@localhost:6543/test_database",
      CLIENT_ADDRESS_SOURCE: "caddy",
      DEPLOYMENT_REVISION: "test-release.12",
      HOST: "0.0.0.0",
      LOG_LEVEL: "debug",
      NODE_ENV: "test",
      PORT: "4100",
      PUBLIC_ORIGIN: "http://127.0.0.1:5173/",
    });

    expect(config).toMatchObject({
      deploymentRevision: "test-release.12",
      clientAddressSource: "caddy",
      emailDelivery: "fake",
      host: "0.0.0.0",
      logLevel: "debug",
      modelGateway: "fake",
      nodeEnv: "test",
      port: 4100,
      publicOrigin: "http://127.0.0.1:5173",
    });
  });

  it("uses the provider-neutral commit as the canonical production release", () => {
    const config = loadConfig(productionEnvironment);

    expect(config.deploymentRevision).toBe(productionEnvironment.DEPLOYMENT_REVISION);
    expect(config.clientAddressSource).toBe("caddy");
    expect(config.webAssetsDirectory).toMatch(/\/apps\/web\/dist\/?$/u);
    expect(config.otlpHeaders).toEqual({ "api-key": "test-license-key-never-sent" });
    expect(Object.isFrozen(config.otlpHeaders)).toBe(true);
  });

  it("requires both OTLP settings when telemetry is enabled outside production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.nr-data.net",
      }),
    ).toThrow("OTEL_EXPORTER_OTLP_HEADERS");
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        OTEL_EXPORTER_OTLP_HEADERS: "api-key=test-license-key",
      }),
    ).toThrow("OTEL_EXPORTER_OTLP_ENDPOINT");
  });

  it("loads migration configuration without unrelated production settings", () => {
    const config = loadDatabaseConfig({
      DATABASE_URL: productionEnvironment.DATABASE_URL,
      NODE_ENV: "production",
    });

    expect(config).toEqual({ databaseUrl: productionEnvironment.DATABASE_URL });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("loads identity operator configuration without model or telemetry credentials", () => {
    const config = loadIdentityOperatorConfig({
      BETTER_AUTH_SECRET: productionEnvironment.BETTER_AUTH_SECRET,
      DATABASE_URL: productionEnvironment.DATABASE_URL,
      EMAIL_DELIVERY: productionEnvironment.EMAIL_DELIVERY,
      EMAIL_FROM: productionEnvironment.EMAIL_FROM,
      NODE_ENV: "production",
      PUBLIC_ORIGIN: productionEnvironment.PUBLIC_ORIGIN,
      RESEND_API_KEY: productionEnvironment.RESEND_API_KEY,
    });

    expect(config).toEqual({
      authSecret: productionEnvironment.BETTER_AUTH_SECRET,
      databaseUrl: productionEnvironment.DATABASE_URL,
      emailDelivery: "resend",
      emailFrom: productionEnvironment.EMAIL_FROM,
      nodeEnv: "production",
      publicOrigin: productionEnvironment.PUBLIC_ORIGIN,
      resendApiKey: productionEnvironment.RESEND_API_KEY,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("loads the recovery migration URL and its strict-file path together", () => {
    const config = loadRecoveryPreparationOperatorConfig({
      CAPSTONE_SECRET_FILE: "/run/capstone-secrets/migration.json",
      DATABASE_URL: productionEnvironment.DATABASE_URL,
      NODE_ENV: "production",
    });

    expect(config).toEqual({
      databaseUrl: productionEnvironment.DATABASE_URL,
      migrationSecretFilePath: "/run/capstone-secrets/migration.json",
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("loads the backend-only OpenRouter operator credential independently", () => {
    expect(
      loadOpenRouterOperatorConfig({ OPENROUTER_API_KEY: "test-openrouter-key-never-sent" }),
    ).toEqual({ apiKey: "test-openrouter-key-never-sent" });
    expect(() => loadOpenRouterOperatorConfig({})).toThrow("OPENROUTER_API_KEY");
  });

  it("identifies the invalid configuration field without exposing its value", () => {
    let error: unknown;
    try {
      loadDatabaseConfig({ DATABASE_URL: "not-a-database-url", NODE_ENV: "production" });
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({ configurationKey: "DATABASE_URL" });
    expect(JSON.stringify(error)).not.toContain("not-a-database-url");
  });

  it.each([
    [{ NODE_ENV: "production", PUBLIC_ORIGIN: "https://chat.capstone.com.ec" }, "DATABASE_URL"],
    [{ ...productionEnvironment, BETTER_AUTH_SECRET: undefined }, "BETTER_AUTH_SECRET"],
    [
      {
        DATABASE_URL: "postgresql://app:secret@database.internal/capstone?sslmode=verify-full",
        NODE_ENV: "production",
      },
      "PUBLIC_ORIGIN",
    ],
    [{ ...productionEnvironment, PUBLIC_ORIGIN: "http://chat.capstone.com.ec" }, "https"],
    [{ ...productionEnvironment, PUBLIC_ORIGIN: "https://other.capstone.com.ec" }, "approved"],
    [{ ...productionEnvironment, HOST: undefined }, "HOST"],
    [{ ...productionEnvironment, HOST: "0.0.0.0" }, "127.0.0.1"],
    [{ ...productionEnvironment, CLIENT_ADDRESS_SOURCE: undefined }, "CLIENT_ADDRESS_SOURCE"],
    [{ ...productionEnvironment, CLIENT_ADDRESS_SOURCE: "socket" }, "must be caddy"],
    [{ ...productionEnvironment, PORT: "0" }, "PORT"],
    [{ ...productionEnvironment, DATABASE_URL: "https://database.internal/capstone" }, "postgres"],
    [
      {
        ...productionEnvironment,
        DATABASE_URL: "postgresql://app:secret@database.internal:6432/capstone?sslmode=verify-full",
      },
      "direct port 5432",
    ],
    [
      {
        ...productionEnvironment,
        DATABASE_URL:
          "postgresql://app:secret@database.internal:5432/capstone?sslmode=verify-full&host=override.invalid",
      },
      "direct port 5432",
    ],
    [
      {
        ...productionEnvironment,
        DATABASE_URL:
          "postgresql://app:secret@database.internal:5432/capstone?sslmode=verify-full&user=override",
      },
      "direct port 5432",
    ],
    [
      {
        ...productionEnvironment,
        DATABASE_URL: "postgresql://app:secret@database.internal:5432/capstone",
      },
      "verify-full",
    ],
    [
      {
        ...productionEnvironment,
        DATABASE_URL:
          "postgresql://app:secret@database.internal:5432/capstone?sslmode=verify-full&sslrootcert=/secret/path",
      },
      "platform-trusted TLS",
    ],
    [
      {
        ...productionEnvironment,
        DATABASE_URL:
          "postgresql://app:secret@database.internal:5432/capstone?sslmode=verify-full&sslmode=disable",
      },
      "exactly one verify-full",
    ],
    [
      {
        ...productionEnvironment,
        DATABASE_URL:
          "postgresql://app:secret@database.internal:5432/capstone?sslmode=verify-full&options=-c%20statement_timeout%3D0",
      },
      "direct port 5432",
    ],
    [
      {
        ...productionEnvironment,
        DATABASE_URL: "postgresql://app:secret@203.0.113.10:5432/capstone?sslmode=verify-full",
      },
      "DNS host",
    ],
    [{ ...productionEnvironment, LOG_LEVEL: "verbose" }, "LOG_LEVEL"],
    [{ ...productionEnvironment, BETTER_AUTH_SECRET: "too-short" }, "32 characters"],
    [{ ...productionEnvironment, EMAIL_DELIVERY: "fake" }, "must be resend"],
    [{ ...productionEnvironment, EMAIL_DELIVERY: "disabled" }, "must be resend"],
    [{ ...productionEnvironment, EMAIL_DELIVERY: "provider" }, "disabled, fake, or resend"],
    [{ ...productionEnvironment, EMAIL_DELIVERY: undefined }, "EMAIL_DELIVERY"],
    [{ ...productionEnvironment, RESEND_API_KEY: undefined }, "RESEND_API_KEY"],
    [{ ...productionEnvironment, EMAIL_FROM: undefined }, "EMAIL_FROM"],
    [{ ...productionEnvironment, EMAIL_FROM: "Other <other@example.com>" }, "approved"],
    [{ ...productionEnvironment, MODEL_GATEWAY: "fake" }, "prohibited"],
    [{ ...productionEnvironment, MODEL_GATEWAY: "other" }, "fake or openrouter"],
    [{ ...productionEnvironment, MODEL_GATEWAY: undefined }, "MODEL_GATEWAY"],
    [{ ...productionEnvironment, OPENROUTER_API_KEY: undefined }, "OPENROUTER_API_KEY"],
    [{ ...productionEnvironment, DEPLOYMENT_REVISION: undefined }, "DEPLOYMENT_REVISION"],
    [{ ...productionEnvironment, DEPLOYMENT_REVISION: "short" }, "full Git commit"],
    [{ ...productionEnvironment, OTEL_EXPORTER_OTLP_ENDPOINT: undefined }, "OTLP_ENDPOINT"],
    [{ ...productionEnvironment, OTEL_EXPORTER_OTLP_HEADERS: undefined }, "OTLP_HEADERS"],
    [
      { ...productionEnvironment, OTEL_EXPORTER_OTLP_ENDPOINT: "http://otlp.nr-data.net" },
      "HTTPS origin",
    ],
    [
      {
        ...productionEnvironment,
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.nr-data.net/v1/traces",
      },
      "HTTPS origin",
    ],
    [
      { ...productionEnvironment, OTEL_EXPORTER_OTLP_ENDPOINT: "https://telemetry.example.com" },
      "New Relic",
    ],
    [
      {
        ...productionEnvironment,
        OTEL_EXPORTER_OTLP_HEADERS: "api-key=first,api-key=second",
      },
      "exactly one",
    ],
    [{ ...productionEnvironment, OTEL_EXPORTER_OTLP_HEADERS: "authorization=value" }, "api-key"],
  ] satisfies [NodeJS.ProcessEnv, string][])(
    "rejects invalid production configuration %#",
    (environment, message) => {
      expect(() => loadConfig(environment)).toThrow(message);
    },
  );

  it("does not expose the database URL in startup metadata", () => {
    const metadata = publicConfigMetadata(loadConfig(productionEnvironment));

    expect(metadata).not.toHaveProperty("databaseUrl");
    expect(metadata).not.toHaveProperty("authSecret");
    expect(metadata).not.toHaveProperty("openRouterApiKey");
    expect(metadata).not.toHaveProperty("otlpHeaders");
    expect(metadata).not.toHaveProperty("resendApiKey");
    expect(metadata).not.toHaveProperty("emailFrom");
    expect(JSON.stringify(metadata)).not.toContain("secret");
    expect(Object.isFrozen(metadata)).toBe(true);
  });
});
