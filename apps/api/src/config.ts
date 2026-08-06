import { loadEnvironmentFile } from "./environment.js";

loadEnvironmentFile();

const runtimeModes = ["development", "test", "production"] as const;
const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type RuntimeMode = (typeof runtimeModes)[number];
export type LogLevel = (typeof logLevels)[number];

export interface ApiConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly logLevel: LogLevel;
  readonly nodeEnv: RuntimeMode;
  readonly port: number;
  readonly publicOrigin: string;
}

const developmentDefaults = {
  databaseUrl: "postgresql://capstone:capstone@127.0.0.1:5432/capstone_chat",
  host: "127.0.0.1",
  port: 3000,
  publicOrigin: "http://localhost:5173",
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
  key: "DATABASE_URL" | "PUBLIC_ORIGIN",
  fallback: string | undefined,
): string {
  const value = source[key]?.trim() || fallback;

  if (value === undefined) {
    throw new Error(`${key} is required in production`);
  }

  return value;
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
    databaseUrl,
    host: readHost(source.HOST, nodeEnv),
    logLevel: readLogLevel(source.LOG_LEVEL, nodeEnv),
    nodeEnv,
    port: readPort(source.PORT),
    publicOrigin,
  });
}

export function publicConfigMetadata(config: ApiConfig): Readonly<Record<string, unknown>> {
  return Object.freeze({
    host: config.host,
    logLevel: config.logLevel,
    nodeEnv: config.nodeEnv,
    port: config.port,
    publicOrigin: config.publicOrigin,
  });
}
