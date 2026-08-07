import { loadEnvironmentFile } from "./environment.js";

loadEnvironmentFile();

const runtimeModes = ["development", "test", "production"] as const;
const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type RuntimeMode = (typeof runtimeModes)[number];
export type LogLevel = (typeof logLevels)[number];
export type EmailDelivery = "disabled" | "fake";

export interface ApiConfig {
  readonly authSecret: string;
  readonly databaseUrl: string;
  readonly emailDelivery: EmailDelivery;
  readonly host: string;
  readonly logLevel: LogLevel;
  readonly nodeEnv: RuntimeMode;
  readonly port: number;
  readonly publicOrigin: string;
  readonly trustProxy: false;
}

const developmentDefaults = {
  databaseUrl: "postgresql://capstone:capstone@127.0.0.1:5432/capstone_chat",
  host: "127.0.0.1",
  port: 3000,
  publicOrigin: "http://localhost:5173",
  authSecret: "capstone-chat-local-auth-secret-not-for-production-use",
} as const;

function isIncluded<const T extends string>(values: readonly T[], value: string): value is T {
  return values.some((candidate) => candidate === value);
}

function readRuntimeMode(value: string | undefined): RuntimeMode {
  const mode = value ?? "development";

  if (!isIncluded(runtimeModes, mode)) {
    throw new Error("NODE_ENV must be development, test, or production");
  }

  return mode;
}

function readRequired(
  source: NodeJS.ProcessEnv,
  key: "BETTER_AUTH_SECRET" | "DATABASE_URL" | "PUBLIC_ORIGIN",
  fallback: string | undefined,
): string {
  const value = source[key]?.trim() || fallback;

  if (value === undefined) {
    throw new Error(`${key} is required in production`);
  }

  return value;
}

function readAuthSecret(source: NodeJS.ProcessEnv, mode: RuntimeMode): string {
  const secret = readRequired(
    source,
    "BETTER_AUTH_SECRET",
    mode === "production" ? undefined : developmentDefaults.authSecret,
  );

  if (secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  }

  return secret;
}

function readEmailDelivery(value: string | undefined, mode: RuntimeMode): EmailDelivery {
  const delivery = value?.trim() || (mode === "production" ? undefined : "fake");

  if (delivery === undefined) {
    throw new Error("EMAIL_DELIVERY is required in production");
  }

  if (delivery !== "fake" && delivery !== "disabled") {
    throw new Error("EMAIL_DELIVERY must be fake or disabled");
  }

  if (mode === "production" && delivery === "fake") {
    throw new Error("EMAIL_DELIVERY=fake is prohibited in production");
  }

  return delivery;
}

function readHost(value: string | undefined, mode: RuntimeMode): string {
  const host = value?.trim() || (mode === "production" ? "0.0.0.0" : developmentDefaults.host);

  if (host.length === 0 || /\s/u.test(host)) {
    throw new Error("HOST must be a non-empty hostname or IP address");
  }

  return host;
}

function readPort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return developmentDefaults.port;
  }

  if (!/^\d+$/u.test(value)) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }

  const port = Number(value);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }

  return port;
}

function readDatabaseUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use the postgres or postgresql protocol");
  }

  return value;
}

function readPublicOrigin(value: string, mode: RuntimeMode): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be a valid HTTP origin");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PUBLIC_ORIGIN must use the http or https protocol");
  }

  if (mode === "production" && url.protocol !== "https:") {
    throw new Error("PUBLIC_ORIGIN must use https in production");
  }

  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("PUBLIC_ORIGIN must contain only an origin");
  }

  return url.origin;
}

function readLogLevel(value: string | undefined, mode: RuntimeMode): LogLevel {
  const level = value?.trim() || (mode === "test" ? "silent" : "info");

  if (!isIncluded(logLevels, level)) {
    throw new Error("LOG_LEVEL is not supported");
  }

  return level;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Readonly<ApiConfig> {
  const nodeEnv = readRuntimeMode(source.NODE_ENV);
  const allowDevelopmentDefaults = nodeEnv !== "production";
  const databaseUrl = readDatabaseUrl(
    readRequired(
      source,
      "DATABASE_URL",
      allowDevelopmentDefaults ? developmentDefaults.databaseUrl : undefined,
    ),
  );
  const publicOrigin = readPublicOrigin(
    readRequired(
      source,
      "PUBLIC_ORIGIN",
      allowDevelopmentDefaults ? developmentDefaults.publicOrigin : undefined,
    ),
    nodeEnv,
  );

  return Object.freeze({
    authSecret: readAuthSecret(source, nodeEnv),
    databaseUrl,
    emailDelivery: readEmailDelivery(source.EMAIL_DELIVERY, nodeEnv),
    host: readHost(source.HOST, nodeEnv),
    logLevel: readLogLevel(source.LOG_LEVEL, nodeEnv),
    nodeEnv,
    port: readPort(source.PORT),
    publicOrigin,
    trustProxy: false,
  });
}

export function publicConfigMetadata(config: ApiConfig): Readonly<Record<string, unknown>> {
  return Object.freeze({
    emailDelivery: config.emailDelivery,
    host: config.host,
    logLevel: config.logLevel,
    nodeEnv: config.nodeEnv,
    port: config.port,
    publicOrigin: config.publicOrigin,
    trustProxy: config.trustProxy,
  });
}
