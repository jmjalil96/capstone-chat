import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  loadConfig,
  loadDatabaseConfig,
  loadEgressBootstrapConfig,
  loadIdentityOperatorConfig,
  loadInitializationOperatorConfig,
  loadManagedRehearsalInitializationConfig,
  loadMigrationConfig,
  loadOpenRouterOperatorConfig,
  loadRecoveryPreparationOperatorConfig,
  publicConfigMetadata,
} from "../src/config.js";

const productionEnvironment = {
  BETTER_AUTH_SECRET: "production-auth-secret-with-at-least-thirty-two-characters",
  CAPSTONE_SECRET_SOURCE: "platform-environment",
  CLIENT_ADDRESS_SOURCE: "digitalocean-app-platform",
  DATABASE_URL: "postgresql://app:secret@database.internal:5432/capstone?sslmode=verify-full",
  DEPLOYMENT_TARGET: "digitalocean-app-platform",
  DEPLOYMENT_REVISION: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  EMAIL_DELIVERY: "resend",
  EMAIL_FROM: "Capstone Chat <no-reply@mail.capstone.com.ec>",
  HOST: "0.0.0.0",
  MODEL_GATEWAY: "openrouter",
  NODE_ENV: "production",
  OPENROUTER_API_KEY: "test-openrouter-key-never-sent",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.nr-data.net",
  OTEL_EXPORTER_OTLP_HEADERS: "api-key=test-license-key-never-sent",
  PUBLIC_ORIGIN: "https://chat.capstone.com.ec",
  RESEND_API_KEY: "test-resend-key-never-sent",
} satisfies NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("rejects production credentials without the exact platform authority", () => {
    const keys = [...Object.keys(productionEnvironment), "CAPSTONE_SECRET_FILE"];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, productionEnvironment);
      delete process.env.CAPSTONE_SECRET_FILE;
      delete process.env.CAPSTONE_SECRET_SOURCE;

      expect(() => loadConfig()).toThrow("CAPSTONE_SECRET_SOURCE");
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

  it("accepts component-scoped production environment credentials", () => {
    const keys = [...Object.keys(productionEnvironment), "CAPSTONE_SECRET_FILE"];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      for (const [key, value] of Object.entries(productionEnvironment)) {
        process.env[key] = value;
      }
      delete process.env.CAPSTONE_SECRET_FILE;

      expect(loadConfig().nodeEnv).toBe("production");
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

  it("returns frozen development defaults", () => {
    const config = loadConfig({});

    expect(config).toEqual({
      authSecret: "capstone-chat-local-auth-secret-not-for-production-use",
      clientAddressSource: "socket",
      databaseUrl: "postgresql://capstone:capstone@127.0.0.1:5432/capstone_chat",
      deploymentProfile: null,
      deploymentRevision: "development",
      deploymentTarget: null,
      emailDelivery: "fake",
      emailFrom: null,
      host: "127.0.0.1",
      logLevel: "info",
      loadDiagnosticsSecret: null,
      modelGateway: "fake",
      nodeEnv: "development",
      openRouterApiKey: null,
      otlpEndpoint: null,
      otlpHeaders: {},
      port: 3000,
      publicOrigin: "http://localhost:5173",
      resendApiKey: null,
      secretSource: null,
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

  it("serves the production build only in production or an explicit test rehearsal", () => {
    expect(loadConfig({ NODE_ENV: "test" }).webAssetsDirectory).toBeNull();

    const rehearsal = loadConfig({
      DATABASE_URL: productionEnvironment.DATABASE_URL,
      NODE_ENV: "test",
      WEB_ASSETS: "production-build",
    });
    expect(rehearsal.webAssetsDirectory).toMatch(/\/apps\/web\/dist\/?$/u);
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgresql://tester:tester@localhost:6543/test_database",
        NODE_ENV: "test",
        WEB_ASSETS: "production-build",
      }),
    ).toThrow("verify-full");

    expect(() => loadConfig({ NODE_ENV: "development", WEB_ASSETS: "production-build" })).toThrow(
      "managed test rehearsal",
    );
    expect(() => loadConfig({ NODE_ENV: "test", WEB_ASSETS: "true" })).toThrow(
      "managed test rehearsal",
    );
    expect(() =>
      loadConfig({
        ...productionEnvironment,
        MODEL_GATEWAY: "fake",
        WEB_ASSETS: "production-build",
      }),
    ).toThrow("prohibited in production");
    expect(() =>
      loadConfig({
        ...productionEnvironment,
        EMAIL_DELIVERY: "disabled",
        WEB_ASSETS: "production-build",
      }),
    ).toThrow("must be resend in production");
  });

  it("uses the image commit and App Platform as the canonical production authority", () => {
    const config = loadConfig(productionEnvironment);

    expect(config.deploymentRevision).toBe(productionEnvironment.DEPLOYMENT_REVISION);
    expect(config.clientAddressSource).toBe("digitalocean-app-platform");
    expect(config.deploymentTarget).toBe("digitalocean-app-platform");
    expect(config.secretSource).toBe("platform-environment");
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

  it("accepts the exact EU New Relic account region", () => {
    const config = loadConfig({
      ...productionEnvironment,
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.eu01.nr-data.net",
    });

    expect(config.otlpEndpoint).toBe("https://otlp.eu01.nr-data.net");
  });

  it("loads migration configuration without unrelated production settings", () => {
    const config = loadDatabaseConfig({
      CAPSTONE_SECRET_SOURCE: productionEnvironment.CAPSTONE_SECRET_SOURCE,
      DATABASE_URL: productionEnvironment.DATABASE_URL,
      DEPLOYMENT_TARGET: productionEnvironment.DEPLOYMENT_TARGET,
      NODE_ENV: "production",
    });

    expect(config).toEqual({ databaseUrl: productionEnvironment.DATABASE_URL });
    expect(Object.isFrozen(config)).toBe(true);
    expect(() =>
      loadDatabaseConfig({
        CAPSTONE_SECRET_SOURCE: productionEnvironment.CAPSTONE_SECRET_SOURCE,
        DATABASE_URL: productionEnvironment.DATABASE_URL,
        DEPLOYMENT_TARGET: productionEnvironment.DEPLOYMENT_TARGET,
        NODE_ENV: "production",
        OPENROUTER_API_KEY: productionEnvironment.OPENROUTER_API_KEY,
      }),
    ).toThrow("migration job cannot receive application");
  });

  it("loads identity operator configuration without model or telemetry credentials", () => {
    const config = loadIdentityOperatorConfig({
      BETTER_AUTH_SECRET: productionEnvironment.BETTER_AUTH_SECRET,
      CAPSTONE_SECRET_SOURCE: productionEnvironment.CAPSTONE_SECRET_SOURCE,
      DATABASE_URL: productionEnvironment.DATABASE_URL,
      DEPLOYMENT_TARGET: productionEnvironment.DEPLOYMENT_TARGET,
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

  it("loads the secret-free App Platform egress bootstrap contract", () => {
    const config = loadEgressBootstrapConfig({
      CAPSTONE_SECRET_SOURCE: "platform-environment",
      CLIENT_ADDRESS_SOURCE: "digitalocean-app-platform",
      DEPLOYMENT_REVISION: productionEnvironment.DEPLOYMENT_REVISION,
      DEPLOYMENT_TARGET: "digitalocean-app-platform",
      HOST: "0.0.0.0",
      NODE_ENV: "production",
      PORT: "3000",
    });

    expect(config).toEqual({
      clientAddressSource: "digitalocean-app-platform",
      deploymentRevision: productionEnvironment.DEPLOYMENT_REVISION,
      deploymentTarget: "digitalocean-app-platform",
      host: "0.0.0.0",
      nodeEnv: "production",
      port: 3000,
      secretSource: "platform-environment",
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(() =>
      loadEgressBootstrapConfig({
        CAPSTONE_SECRET_SOURCE: "platform-environment",
        CLIENT_ADDRESS_SOURCE: "digitalocean-app-platform",
        DATABASE_URL: productionEnvironment.DATABASE_URL,
        DEPLOYMENT_REVISION: productionEnvironment.DEPLOYMENT_REVISION,
        DEPLOYMENT_TARGET: "digitalocean-app-platform",
        HOST: "0.0.0.0",
        NODE_ENV: "production",
        PORT: "3000",
      }),
    ).toThrow("cannot receive runtime secrets");
  });

  it("loads only distinct temporary roles and bounded input for initialization", () => {
    const environment = {
      CAPSTONE_BOOTSTRAP_DATABASE_URL:
        "postgresql://initializer:app@database.internal:5432/capstone?sslmode=verify-full",
      CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL:
        "postgresql://initializer_migrate:migrate@database.internal:5432/capstone?sslmode=verify-full",
      CAPSTONE_INITIALIZATION_DOCUMENT: '{"schemaVersion":1}',
      CAPSTONE_INITIALIZATION_SCHEMA_VERSION: "1",
      CAPSTONE_SECRET_SOURCE: "platform-environment",
      DEPLOYMENT_REVISION: productionEnvironment.DEPLOYMENT_REVISION,
      DEPLOYMENT_TARGET: "digitalocean-app-platform",
      MODEL_GATEWAY: "openrouter",
      NODE_ENV: "production",
      OPENROUTER_API_KEY: "temporary-catalog-key",
    } satisfies NodeJS.ProcessEnv;

    const config = loadInitializationOperatorConfig(environment);

    expect(config).toMatchObject({
      applicationDatabaseUrl: environment.CAPSTONE_BOOTSTRAP_DATABASE_URL,
      initializationDocument: environment.CAPSTONE_INITIALIZATION_DOCUMENT,
      initializationSchemaVersion: 1,
      migrationDatabaseUrl: environment.CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL,
      modelGateway: "openrouter",
      openRouterApiKey: "temporary-catalog-key",
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(() =>
      loadInitializationOperatorConfig({
        ...environment,
        CAPSTONE_INITIALIZATION_DOCUMENT: `{"value":"${"x".repeat(32 * 1_024)}"}`,
      }),
    ).toThrow("32768 UTF-8 bytes");
    expect(() =>
      loadInitializationOperatorConfig({
        ...environment,
        CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL: environment.CAPSTONE_BOOTSTRAP_DATABASE_URL,
      }),
    ).toThrow("must be distinct");
    expect(() =>
      loadInitializationOperatorConfig({
        ...environment,
        CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL:
          "postgresql://initializer_migrate:migrate@other.internal:5432/capstone?sslmode=verify-full",
      }),
    ).toThrow("same database");
    expect(() =>
      loadInitializationOperatorConfig({
        ...environment,
        BETTER_AUTH_SECRET: productionEnvironment.BETTER_AUTH_SECRET,
      }),
    ).toThrow("cannot receive steady application credentials");
    expect(() => loadInitializationOperatorConfig({ ...environment, HOST: "0.0.0.0" })).toThrow(
      "cannot receive steady application credentials",
    );
  });

  it("loads the exact managed rehearsal without any provider or delivery credential", () => {
    const environment = {
      BETTER_AUTH_SECRET: productionEnvironment.BETTER_AUTH_SECRET,
      CAPSTONE_DEPLOYMENT_PROFILE: "managed-rehearsal",
      CAPSTONE_LOAD_DIAGNOSTICS_SECRET: "diagnostics-secret-with-at-least-32-characters",
      CAPSTONE_SECRET_SOURCE: "platform-environment",
      CLIENT_ADDRESS_SOURCE: "digitalocean-app-platform",
      DATABASE_URL: productionEnvironment.DATABASE_URL,
      DEPLOYMENT_REVISION: productionEnvironment.DEPLOYMENT_REVISION,
      DEPLOYMENT_TARGET: "digitalocean-app-platform",
      EMAIL_DELIVERY: "disabled",
      HOST: "0.0.0.0",
      LOG_LEVEL: "info",
      MODEL_GATEWAY: "openrouter",
      NODE_ENV: "test",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.eu01.nr-data.net",
      OTEL_EXPORTER_OTLP_HEADERS: "api-key=test-license-key-never-sent",
      PORT: "3000",
      PUBLIC_ORIGIN: "https://rehearsal.chat.capstone.com.ec",
      WEB_ASSETS: "production-build",
    } satisfies NodeJS.ProcessEnv;

    const config = loadConfig(environment);
    expect(config).toMatchObject({
      deploymentProfile: "managed-rehearsal",
      emailDelivery: "disabled",
      loadDiagnosticsSecret: environment.CAPSTONE_LOAD_DIAGNOSTICS_SECRET,
      modelGateway: "openrouter",
      nodeEnv: "test",
      openRouterApiKey: null,
      publicOrigin: "https://rehearsal.chat.capstone.com.ec",
    });
    for (const [key, value] of [
      ["OPENROUTER_API_KEY", "provider-key"],
      ["RESEND_API_KEY", "delivery-key"],
      ["CAPSTONE_BOOTSTRAP_DATABASE_URL", productionEnvironment.DATABASE_URL],
    ] as const) {
      expect(() => loadConfig({ ...environment, [key]: value })).toThrow(
        "managed rehearsal service cannot receive",
      );
    }
    expect(() => loadConfig({ ...environment, PUBLIC_ORIGIN: "https://evil.example" })).toThrow(
      "must be https://rehearsal.chat.capstone.com.ec",
    );
    expect(() => loadConfig({ ...environment, CAPSTONE_LOAD_DIAGNOSTICS_SECRET: "short" })).toThrow(
      "32 to 256",
    );
  });

  it("keeps managed migration and initialization component environments disjoint", () => {
    const authority = {
      CAPSTONE_DEPLOYMENT_PROFILE: "managed-rehearsal",
      CAPSTONE_SECRET_SOURCE: "platform-environment",
      DEPLOYMENT_REVISION: productionEnvironment.DEPLOYMENT_REVISION,
      DEPLOYMENT_TARGET: "digitalocean-app-platform",
      NODE_ENV: "test",
    } satisfies NodeJS.ProcessEnv;
    expect(
      loadMigrationConfig({ ...authority, DATABASE_URL: productionEnvironment.DATABASE_URL }),
    ).toEqual({ databaseUrl: productionEnvironment.DATABASE_URL });
    expect(() =>
      loadMigrationConfig({
        ...authority,
        BETTER_AUTH_SECRET: productionEnvironment.BETTER_AUTH_SECRET,
        DATABASE_URL: productionEnvironment.DATABASE_URL,
      }),
    ).toThrow("migration job cannot receive");

    const initialization = {
      ...authority,
      CAPSTONE_BOOTSTRAP_DATABASE_URL:
        "postgresql://initializer:app@database.internal:5432/capstone?sslmode=verify-full",
      CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL:
        "postgresql://initializer_migrate:migrate@database.internal:5432/capstone?sslmode=verify-full",
      CAPSTONE_INITIALIZATION_DOCUMENT: '{"schemaVersion":1}',
      CAPSTONE_INITIALIZATION_SCHEMA_VERSION: "1",
    } satisfies NodeJS.ProcessEnv;
    expect(loadManagedRehearsalInitializationConfig(initialization)).toMatchObject({
      deploymentProfile: "managed-rehearsal",
      nodeEnv: "test",
    });
    for (const [key, value] of [
      ["OPENROUTER_API_KEY", "provider-key"],
      ["HOST", "0.0.0.0"],
      ["BETTER_AUTH_SECRET", productionEnvironment.BETTER_AUTH_SECRET],
    ] as const) {
      expect(() =>
        loadManagedRehearsalInitializationConfig({ ...initialization, [key]: value }),
      ).toThrow("managed rehearsal initialization job cannot receive");
    }
  });

  it("identifies the invalid configuration field without exposing its value", () => {
    let error: unknown;
    try {
      loadDatabaseConfig({
        CAPSTONE_SECRET_SOURCE: productionEnvironment.CAPSTONE_SECRET_SOURCE,
        DATABASE_URL: "not-a-database-url",
        DEPLOYMENT_TARGET: productionEnvironment.DEPLOYMENT_TARGET,
        NODE_ENV: "production",
      });
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({ configurationKey: "DATABASE_URL" });
    expect(JSON.stringify(error)).not.toContain("not-a-database-url");
  });

  it.each([
    [
      {
        CAPSTONE_SECRET_SOURCE: productionEnvironment.CAPSTONE_SECRET_SOURCE,
        DEPLOYMENT_TARGET: productionEnvironment.DEPLOYMENT_TARGET,
        NODE_ENV: "production",
        PUBLIC_ORIGIN: "https://chat.capstone.com.ec",
      },
      "DATABASE_URL",
    ],
    [{ ...productionEnvironment, BETTER_AUTH_SECRET: undefined }, "BETTER_AUTH_SECRET"],
    [
      {
        CAPSTONE_SECRET_SOURCE: productionEnvironment.CAPSTONE_SECRET_SOURCE,
        DATABASE_URL: "postgresql://app:secret@database.internal/capstone?sslmode=verify-full",
        DEPLOYMENT_TARGET: productionEnvironment.DEPLOYMENT_TARGET,
        NODE_ENV: "production",
      },
      "PUBLIC_ORIGIN",
    ],
    [{ ...productionEnvironment, PUBLIC_ORIGIN: "http://chat.capstone.com.ec" }, "https"],
    [{ ...productionEnvironment, PUBLIC_ORIGIN: "https://other.capstone.com.ec" }, "approved"],
    [{ ...productionEnvironment, HOST: undefined }, "HOST"],
    [{ ...productionEnvironment, HOST: "127.0.0.1" }, "0.0.0.0"],
    [{ ...productionEnvironment, CLIENT_ADDRESS_SOURCE: undefined }, "CLIENT_ADDRESS_SOURCE"],
    [
      { ...productionEnvironment, CLIENT_ADDRESS_SOURCE: "caddy" },
      "must be digitalocean-app-platform",
    ],
    [{ ...productionEnvironment, DEPLOYMENT_TARGET: undefined }, "DEPLOYMENT_TARGET"],
    [
      { ...productionEnvironment, DEPLOYMENT_TARGET: "digitalocean-droplet" },
      "digitalocean-app-platform",
    ],
    [{ ...productionEnvironment, CAPSTONE_SECRET_SOURCE: undefined }, "CAPSTONE_SECRET_SOURCE"],
    [{ ...productionEnvironment, CAPSTONE_SECRET_SOURCE: "file" }, "platform-environment"],
    [{ ...productionEnvironment, CAPSTONE_SECRET_FILE: "/run/secrets/runtime.json" }, "prohibited"],
    [
      { ...productionEnvironment, CAPSTONE_INITIALIZATION_DOCUMENT: "{}" },
      "cannot receive initialization credentials",
    ],
    [{ ...productionEnvironment, PORT: "0" }, "PORT"],
    [{ ...productionEnvironment, PORT: "3001" }, "must be 3000"],
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
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.staging.nr-data.net",
      },
      "exact US or EU",
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
