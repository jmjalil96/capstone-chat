import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  loadConfig,
  loadDatabaseConfig,
  loadHealthBootstrapConfig,
  loadIdentityOperatorConfig,
  loadInitializationOperatorConfig,
  loadMigrationConfig,
  loadOpenRouterOperatorConfig,
  loadRecoveryPreparationOperatorConfig,
  publicConfigMetadata,
} from "../src/config.js";

const hostedCommon = {
  BETTER_AUTH_SECRET: "hosted-auth-secret-with-at-least-thirty-two-characters",
  DATABASE_URL: "postgresql://app:secret@database.internal:5432/capstone?sslmode=verify-full",
  DEPLOYMENT_REVISION: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  EMAIL_DELIVERY: "resend",
  HOST: "0.0.0.0",
  MODEL_GATEWAY: "openrouter",
  NODE_ENV: "production",
  OPENROUTER_API_KEY: "test-openrouter-key-never-sent",
  OTEL_EXPORTER_OTLP_ENDPOINT: "https://otlp.nr-data.net",
  OTEL_EXPORTER_OTLP_HEADERS: "api-key=test-license-key-never-sent",
  RESEND_API_KEY: "test-resend-key-never-sent",
} satisfies NodeJS.ProcessEnv;

const stagingEnvironment = {
  ...hostedCommon,
  CAPSTONE_ENVIRONMENT: "staging",
  CAPSTONE_STAGING_EMAIL_RECIPIENTS: "administrator@capstone.com.ec,qa@capstone.com.ec",
  EMAIL_FROM: "Capstone Chat Staging <no-reply@staging.mail.capstone.com.ec>",
  PUBLIC_ORIGIN: "https://staging.chat.capstone.com.ec",
} satisfies NodeJS.ProcessEnv;

const productionEnvironment = {
  ...hostedCommon,
  CAPSTONE_ENVIRONMENT: "production",
  EMAIL_FROM: "Capstone Chat <no-reply@mail.capstone.com.ec>",
  PUBLIC_ORIGIN: "https://chat.capstone.com.ec",
} satisfies NodeJS.ProcessEnv;

const initializationCommon = {
  CAPSTONE_BOOTSTRAP_DATABASE_URL:
    "postgresql://initializer:app@database.internal:5432/capstone?sslmode=verify-full",
  CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL:
    "postgresql://initializer_migrate:migrate@database.internal:5432/capstone?sslmode=verify-full",
  CAPSTONE_INITIALIZATION_DOCUMENT: '{"schemaVersion":1}',
  CAPSTONE_INITIALIZATION_SCHEMA_VERSION: "1",
  DEPLOYMENT_REVISION: hostedCommon.DEPLOYMENT_REVISION,
  MODEL_GATEWAY: "openrouter",
  NODE_ENV: "production",
  OPENROUTER_API_KEY: "temporary-catalog-key",
} satisfies NodeJS.ProcessEnv;

describe("application configuration", () => {
  it("returns frozen development defaults only for a non-production NODE_ENV", () => {
    const config = loadConfig({});
    expect(config).toEqual({
      applicationEnvironment: "development",
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
      stagingEmailRecipients: [],
      trustProxy: false,
      webAssetsDirectory: null,
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.otlpHeaders)).toBe(true);
    expect(Object.isFrozen(config.stagingEmailRecipients)).toBe(true);
  });

  it("accepts a complete explicit test fixture and a development OpenRouter opt-in", () => {
    expect(
      loadConfig({
        DATABASE_URL: "postgres://tester:tester@localhost:6543/test_database",
        DEPLOYMENT_REVISION: "test-release.12",
        HOST: "0.0.0.0",
        LOG_LEVEL: "debug",
        NODE_ENV: "test",
        PORT: "4100",
        PUBLIC_ORIGIN: "http://127.0.0.1:5173/",
      }),
    ).toMatchObject({
      applicationEnvironment: "development",
      deploymentRevision: "test-release.12",
      host: "0.0.0.0",
      logLevel: "debug",
      nodeEnv: "test",
      publicOrigin: "http://127.0.0.1:5173",
    });
    expect(() => loadConfig({ MODEL_GATEWAY: "openrouter" })).toThrow("OPENROUTER_API_KEY");
    expect(
      loadConfig({
        MODEL_GATEWAY: "openrouter",
        OPENROUTER_API_KEY: "development-only-key",
      }).modelGateway,
    ).toBe("openrouter");
  });

  it("accepts complete staging and production fixtures with identical hosted safeguards", () => {
    const staging = loadConfig(stagingEnvironment);
    const production = loadConfig(productionEnvironment);
    expect(staging).toMatchObject({
      applicationEnvironment: "staging",
      emailFrom: stagingEnvironment.EMAIL_FROM,
      nodeEnv: "production",
      publicOrigin: stagingEnvironment.PUBLIC_ORIGIN,
      stagingEmailRecipients: ["administrator@capstone.com.ec", "qa@capstone.com.ec"],
    });
    expect(production).toMatchObject({
      applicationEnvironment: "production",
      emailFrom: productionEnvironment.EMAIL_FROM,
      nodeEnv: "production",
      publicOrigin: productionEnvironment.PUBLIC_ORIGIN,
      stagingEmailRecipients: [],
    });
    for (const config of [staging, production]) {
      expect(config.clientAddressSource).toBe("digitalocean-app-platform");
      expect(config.modelGateway).toBe("openrouter");
      expect(config.emailDelivery).toBe("resend");
      expect(config.webAssetsDirectory).toMatch(/\/apps\/web\/dist\/?$/u);
      expect(config.otlpHeaders).toEqual({ "api-key": "test-license-key-never-sent" });
    }
  });

  it("applies direct verify-full PostgreSQL and hosted runtime policy equally", () => {
    for (const environment of [stagingEnvironment, productionEnvironment]) {
      expect(() =>
        loadConfig({
          ...environment,
          DATABASE_URL: "postgresql://app:secret@database.internal:5432/capstone",
        }),
      ).toThrow("verify-full");
      expect(() => loadConfig({ ...environment, MODEL_GATEWAY: "fake" })).toThrow(
        "must be openrouter",
      );
    }
  });

  it.each([
    [{ NODE_ENV: "production" }, "CAPSTONE_ENVIRONMENT"],
    [{ CAPSTONE_ENVIRONMENT: "development", NODE_ENV: "production" }, "non-production"],
    [{ CAPSTONE_ENVIRONMENT: "staging", NODE_ENV: "test" }, "NODE_ENV must be production"],
    [
      { CAPSTONE_ENVIRONMENT: "production", NODE_ENV: "development" },
      "NODE_ENV must be production",
    ],
    [{ CAPSTONE_ENVIRONMENT: "other", NODE_ENV: "test" }, "development, staging, or production"],
  ] satisfies [NodeJS.ProcessEnv, string][])(
    "rejects invalid CAPSTONE_ENVIRONMENT/NODE_ENV pair %#",
    (environment, message) => {
      expect(() => loadConfig(environment)).toThrow(message);
    },
  );

  it("rejects cross-environment origins, senders, and hosted origins in development", () => {
    expect(() =>
      loadConfig({ ...stagingEnvironment, PUBLIC_ORIGIN: productionEnvironment.PUBLIC_ORIGIN }),
    ).toThrow("approved staging origin");
    expect(() =>
      loadConfig({ ...productionEnvironment, PUBLIC_ORIGIN: stagingEnvironment.PUBLIC_ORIGIN }),
    ).toThrow("approved production origin");
    expect(() =>
      loadConfig({ ...stagingEnvironment, EMAIL_FROM: productionEnvironment.EMAIL_FROM }),
    ).toThrow("approved staging sender");
    expect(() =>
      loadConfig({ ...productionEnvironment, EMAIL_FROM: stagingEnvironment.EMAIL_FROM }),
    ).toThrow("approved production sender");
    expect(() => loadConfig({ PUBLIC_ORIGIN: productionEnvironment.PUBLIC_ORIGIN })).toThrow(
      "loopback",
    );
    expect(() => loadConfig({ EMAIL_DELIVERY: "resend" })).toThrow("fake mailbox");
  });

  it("requires a bounded unique normalized staging recipient allowlist", () => {
    expect(() =>
      loadConfig({ ...stagingEnvironment, CAPSTONE_STAGING_EMAIL_RECIPIENTS: undefined }),
    ).toThrow("1 to 10");
    for (const recipients of [
      "Administrator@capstone.com.ec",
      " administrator@capstone.com.ec",
      "administrator@capstone.com.ec,administrator@capstone.com.ec",
      "not-an-email",
      Array.from({ length: 11 }, (_, index) => `qa${index}@capstone.com.ec`).join(","),
    ]) {
      expect(() =>
        loadConfig({ ...stagingEnvironment, CAPSTONE_STAGING_EMAIL_RECIPIENTS: recipients }),
      ).toThrow("CAPSTONE_STAGING_EMAIL_RECIPIENTS");
    }
    expect(() =>
      loadConfig({
        ...productionEnvironment,
        CAPSTONE_STAGING_EMAIL_RECIPIENTS: "qa@capstone.com.ec",
      }),
    ).toThrow("only in staging");
  });

  it.each([
    [{ ...productionEnvironment, BETTER_AUTH_SECRET: undefined }, "BETTER_AUTH_SECRET"],
    [{ ...productionEnvironment, BETTER_AUTH_SECRET: "short" }, "32 characters"],
    [{ ...productionEnvironment, DEPLOYMENT_REVISION: "short" }, "full Git commit"],
    [{ ...productionEnvironment, EMAIL_DELIVERY: "fake" }, "must be resend"],
    [{ ...productionEnvironment, EMAIL_FROM: undefined }, "approved production sender"],
    [{ ...productionEnvironment, HOST: "127.0.0.1" }, "0.0.0.0"],
    [{ ...productionEnvironment, MODEL_GATEWAY: "fake" }, "must be openrouter"],
    [{ ...productionEnvironment, OPENROUTER_API_KEY: undefined }, "OPENROUTER_API_KEY"],
    [{ ...productionEnvironment, PORT: "3001" }, "3000"],
    [{ ...productionEnvironment, RESEND_API_KEY: undefined }, "RESEND_API_KEY"],
    [
      {
        ...productionEnvironment,
        DATABASE_URL: "postgresql://app:secret@database.internal/capstone",
      },
      "verify-full",
    ],
    [
      {
        ...productionEnvironment,
        DATABASE_URL: "postgresql://app:secret@203.0.113.10:5432/capstone?sslmode=verify-full",
      },
      "DNS host",
    ],
    [
      {
        ...productionEnvironment,
        DATABASE_URL: "postgresql://app:secret@database.internal:6432/capstone?sslmode=verify-full",
      },
      "direct port 5432",
    ],
    [{ ...productionEnvironment, OTEL_EXPORTER_OTLP_ENDPOINT: undefined }, "OTLP"],
    [{ ...productionEnvironment, OTEL_EXPORTER_OTLP_HEADERS: "authorization=value" }, "api-key"],
    [
      { ...productionEnvironment, PUBLIC_ORIGIN: "http://chat.capstone.com.ec" },
      "approved production origin",
    ],
    [{ ...productionEnvironment, CAPSTONE_SECRET_FILE: "/run/secrets/runtime.json" }, "prohibited"],
    [
      { ...productionEnvironment, CAPSTONE_INITIALIZATION_DOCUMENT: "{}" },
      "cannot receive initialization",
    ],
  ] satisfies [NodeJS.ProcessEnv, string][])(
    "preserves hosted production safeguard %#",
    (environment, message) => {
      expect(() => loadConfig(environment)).toThrow(message);
    },
  );

  it("keeps database, identity, recovery, and OpenRouter operator boundaries explicit", () => {
    const operatorAuthority = {
      CAPSTONE_ENVIRONMENT: "production",
      DATABASE_URL: productionEnvironment.DATABASE_URL,
      NODE_ENV: "production",
    } satisfies NodeJS.ProcessEnv;
    expect(loadDatabaseConfig(operatorAuthority)).toEqual({
      databaseUrl: productionEnvironment.DATABASE_URL,
    });
    expect(() =>
      loadDatabaseConfig({ ...operatorAuthority, OPENROUTER_API_KEY: "provider-key" }),
    ).toThrow("cannot receive application");

    const identity = loadIdentityOperatorConfig({
      BETTER_AUTH_SECRET: productionEnvironment.BETTER_AUTH_SECRET,
      CAPSTONE_ENVIRONMENT: "production",
      DATABASE_URL: productionEnvironment.DATABASE_URL,
      EMAIL_DELIVERY: "resend",
      EMAIL_FROM: productionEnvironment.EMAIL_FROM,
      NODE_ENV: "production",
      PUBLIC_ORIGIN: productionEnvironment.PUBLIC_ORIGIN,
      RESEND_API_KEY: productionEnvironment.RESEND_API_KEY,
    });
    expect(identity).toMatchObject({
      applicationEnvironment: "production",
      nodeEnv: "production",
      stagingEmailRecipients: [],
    });
    expect(
      loadOpenRouterOperatorConfig({ OPENROUTER_API_KEY: "test-openrouter-key-never-sent" }),
    ).toEqual({ apiKey: "test-openrouter-key-never-sent" });
    expect(() => loadOpenRouterOperatorConfig({})).toThrow("OPENROUTER_API_KEY");

    expect(
      loadRecoveryPreparationOperatorConfig({
        CAPSTONE_SECRET_FILE: "/run/capstone-secrets/migration.json",
        DATABASE_URL: "postgresql://local:local@127.0.0.1:5432/recovery",
        NODE_ENV: "test",
      }),
    ).toEqual({
      databaseUrl: "postgresql://local:local@127.0.0.1:5432/recovery",
      migrationSecretFilePath: "/run/capstone-secrets/migration.json",
    });
  });

  it("reserves secret-file authority exclusively for recovery preparation", () => {
    const source = {
      CAPSTONE_ENVIRONMENT: "production",
      CAPSTONE_SECRET_FILE: "/run/capstone-secrets/recovery.json",
      NODE_ENV: "production",
    };
    for (const load of [
      loadConfig,
      loadDatabaseConfig,
      loadHealthBootstrapConfig,
      loadIdentityOperatorConfig,
      loadInitializationOperatorConfig,
      loadMigrationConfig,
      loadOpenRouterOperatorConfig,
    ]) {
      expect(() => load(source)).toThrow("prohibited in hosted components");
    }
    expect(loadConfig({ CAPSTONE_SECRET_FILE: source.CAPSTONE_SECRET_FILE })).toMatchObject({
      applicationEnvironment: "development",
      databaseUrl: "postgresql://capstone:capstone@127.0.0.1:5432/capstone_chat",
    });
  });

  it.each(["staging", "production"] as const)(
    "accepts only migration credentials and non-secret metadata for %s",
    (applicationEnvironment) => {
      const migration = {
        CAPSTONE_ENVIRONMENT: applicationEnvironment,
        DATABASE_URL: hostedCommon.DATABASE_URL,
        DEPLOYMENT_REVISION: hostedCommon.DEPLOYMENT_REVISION,
        NODE_ENV: "production",
      } satisfies NodeJS.ProcessEnv;
      expect(loadMigrationConfig(migration)).toEqual({ databaseUrl: hostedCommon.DATABASE_URL });
      for (const [key, value] of [
        ["BETTER_AUTH_SECRET", hostedCommon.BETTER_AUTH_SECRET],
        ["OPENROUTER_API_KEY", hostedCommon.OPENROUTER_API_KEY],
        ["OTEL_EXPORTER_OTLP_HEADERS", hostedCommon.OTEL_EXPORTER_OTLP_HEADERS],
        ["RESEND_API_KEY", hostedCommon.RESEND_API_KEY],
      ] as const) {
        expect(() => loadMigrationConfig({ ...migration, [key]: value })).toThrow(
          "migration job cannot receive",
        );
      }
    },
  );

  it.each(["staging", "production"] as const)(
    "uses the schema-1 initializer for %s with distinct temporary database roles",
    (applicationEnvironment) => {
      const environment = {
        ...initializationCommon,
        CAPSTONE_ENVIRONMENT: applicationEnvironment,
      } satisfies NodeJS.ProcessEnv;
      expect(loadInitializationOperatorConfig(environment)).toMatchObject({
        applicationEnvironment,
        initializationSchemaVersion: 1,
        modelGateway: "openrouter",
        nodeEnv: "production",
      });
      expect(() =>
        loadInitializationOperatorConfig({
          ...environment,
          CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL: environment.CAPSTONE_BOOTSTRAP_DATABASE_URL,
        }),
      ).toThrow("distinct");
      expect(() =>
        loadInitializationOperatorConfig({ ...environment, BETTER_AUTH_SECRET: "not-allowed" }),
      ).toThrow("cannot receive steady application");
    },
  );

  it("loads a minimal provider-native health bootstrap for either hosted environment", () => {
    for (const applicationEnvironment of ["staging", "production"] as const) {
      const environment = {
        CAPSTONE_ENVIRONMENT: applicationEnvironment,
        DEPLOYMENT_REVISION: hostedCommon.DEPLOYMENT_REVISION,
        HOST: "0.0.0.0",
        NODE_ENV: "production",
        PORT: "3000",
      } satisfies NodeJS.ProcessEnv;
      expect(loadHealthBootstrapConfig(environment)).toMatchObject({
        applicationEnvironment,
        nodeEnv: "production",
        port: 3000,
      });
      expect(() =>
        loadHealthBootstrapConfig({ ...environment, DATABASE_URL: hostedCommon.DATABASE_URL }),
      ).toThrow("cannot receive runtime secrets");
    }
  });

  it("identifies invalid fields without exposing their values or secrets in metadata", () => {
    let error: unknown;
    try {
      loadConfig({ ...productionEnvironment, DATABASE_URL: "not-a-database-url" });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({ configurationKey: "DATABASE_URL" });
    expect(JSON.stringify(error)).not.toContain("not-a-database-url");

    const metadata = publicConfigMetadata(loadConfig(productionEnvironment));
    for (const key of [
      "databaseUrl",
      "authSecret",
      "openRouterApiKey",
      "otlpHeaders",
      "resendApiKey",
      "emailFrom",
      "stagingEmailRecipients",
    ]) {
      expect(metadata).not.toHaveProperty(key);
    }
    expect(JSON.stringify(metadata)).not.toContain("secret");
    expect(Object.isFrozen(metadata)).toBe(true);
  });
});
