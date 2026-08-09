import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  loadConfig,
  loadDatabaseConfig,
  loadOpenRouterOperatorConfig,
  publicConfigMetadata,
} from "../src/config.js";

const productionEnvironment = {
  BETTER_AUTH_SECRET: "production-auth-secret-with-at-least-thirty-two-characters",
  DATABASE_URL: "postgresql://app:secret@database.internal:5432/capstone",
  EMAIL_DELIVERY: "resend",
  EMAIL_FROM: "Capstone Chat <no-reply@mail.capstone.com.ec>",
  MODEL_GATEWAY: "openrouter",
  NODE_ENV: "production",
  OPENROUTER_API_KEY: "test-openrouter-key-never-sent",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.nr-data.net",
  OTEL_EXPORTER_OTLP_HEADERS: "api-key=test-license-key-never-sent",
  PUBLIC_ORIGIN: "https://chat.capstone.com.ec",
  RENDER_GIT_COMMIT: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  RESEND_API_KEY: "test-resend-key-never-sent",
} satisfies NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("returns frozen development defaults", () => {
    const config = loadConfig({});

    expect(config).toEqual({
      authSecret: "capstone-chat-local-auth-secret-not-for-production-use",
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
      DEPLOYMENT_REVISION: "test-release.12",
      HOST: "0.0.0.0",
      LOG_LEVEL: "debug",
      NODE_ENV: "test",
      PORT: "4100",
      PUBLIC_ORIGIN: "http://127.0.0.1:5173/",
    });

    expect(config).toMatchObject({
      deploymentRevision: "test-release.12",
      emailDelivery: "fake",
      host: "0.0.0.0",
      logLevel: "debug",
      modelGateway: "fake",
      nodeEnv: "test",
      port: 4100,
      publicOrigin: "http://127.0.0.1:5173",
    });
  });

  it("uses Render's commit as the canonical production release", () => {
    const config = loadConfig({
      ...productionEnvironment,
      DEPLOYMENT_REVISION: "ignored-local-override",
    });

    expect(config.deploymentRevision).toBe(productionEnvironment.RENDER_GIT_COMMIT);
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
        DATABASE_URL: "postgresql://database.internal/capstone",
        NODE_ENV: "production",
      },
      "PUBLIC_ORIGIN",
    ],
    [{ ...productionEnvironment, PUBLIC_ORIGIN: "http://chat.capstone.com.ec" }, "https"],
    [{ ...productionEnvironment, PUBLIC_ORIGIN: "https://other.capstone.com.ec" }, "approved"],
    [{ ...productionEnvironment, HOST: "127.0.0.1" }, "0.0.0.0"],
    [{ ...productionEnvironment, PORT: "0" }, "PORT"],
    [{ ...productionEnvironment, DATABASE_URL: "https://database.internal/capstone" }, "postgres"],
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
    [{ ...productionEnvironment, RENDER_GIT_COMMIT: undefined }, "RENDER_GIT_COMMIT"],
    [{ ...productionEnvironment, RENDER_GIT_COMMIT: "short" }, "full Git commit"],
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
