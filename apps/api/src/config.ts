import { fileURLToPath } from "node:url";
import { parseProductionDatabaseUrl } from "./database/production-database-url.js";
import { hasLoadedSecretEnvironment } from "./secret-environment.js";

const runtimeModes = ["development", "test", "production"] as const;
const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type RuntimeMode = (typeof runtimeModes)[number];
export type LogLevel = (typeof logLevels)[number];
export type EmailDelivery = "disabled" | "fake" | "resend";
export type ModelGatewayMode = "fake" | "openrouter";
export type ClientAddressSource = "caddy" | "socket";

export type ConfigurationKey =
  | "BETTER_AUTH_SECRET"
  | "CAPSTONE_SECRET_FILE"
  | "CLIENT_ADDRESS_SOURCE"
  | "DATABASE_URL"
  | "DEPLOYMENT_REVISION"
  | "EMAIL_DELIVERY"
  | "EMAIL_FROM"
  | "HOST"
  | "LOG_LEVEL"
  | "MODEL_GATEWAY"
  | "NODE_ENV"
  | "OPENROUTER_API_KEY"
  | "OTEL_EXPORTER_OTLP_ENDPOINT"
  | "OTEL_EXPORTER_OTLP_HEADERS"
  | "PORT"
  | "PUBLIC_ORIGIN"
  | "RESEND_API_KEY";

export class ConfigurationError extends Error {
  readonly configurationKey: ConfigurationKey;

  constructor(configurationKey: ConfigurationKey, message: string) {
    super(message);
    this.name = "ConfigurationError";
    this.configurationKey = configurationKey;
  }
}

export interface DatabaseConfig {
  readonly databaseUrl: string;
}

export interface OpenRouterOperatorConfig {
  readonly apiKey: string;
}

export interface IdentityOperatorConfig extends DatabaseConfig {
  readonly authSecret: string;
  readonly emailDelivery: EmailDelivery;
  readonly emailFrom: string | null;
  readonly nodeEnv: RuntimeMode;
  readonly publicOrigin: string;
  readonly resendApiKey: string | null;
}

export interface RecoveryPreparationOperatorConfig extends DatabaseConfig {
  readonly migrationSecretFilePath: string;
}

export interface ApiConfig {
  readonly authSecret: string;
  readonly clientAddressSource: ClientAddressSource;
  readonly databaseUrl: string;
  readonly deploymentRevision: string;
  readonly emailDelivery: EmailDelivery;
  readonly emailFrom: string | null;
  readonly host: string;
  readonly logLevel: LogLevel;
  readonly modelGateway: ModelGatewayMode;
  readonly nodeEnv: RuntimeMode;
  readonly openRouterApiKey: string | null;
  readonly otlpEndpoint: string | null;
  readonly otlpHeaders: Readonly<Record<string, string>>;
  readonly port: number;
  readonly publicOrigin: string;
  readonly resendApiKey: string | null;
  readonly trustProxy: false;
  readonly webAssetsDirectory: string | null;
}

const productionOrigin = "https://chat.capstone.com.ec";
const productionSender = "Capstone Chat <no-reply@mail.capstone.com.ec>";
const productionWebAssetsDirectory = fileURLToPath(new URL("../../web/dist/", import.meta.url));

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
    throw new ConfigurationError("NODE_ENV", "NODE_ENV must be development, test, or production");
  }

  return mode;
}

function requireProductionSecretFile(source: NodeJS.ProcessEnv, mode: RuntimeMode): void {
  // Explicit source objects are the configuration seam used by tests. Executable production
  // entry points read process.env only after environment.ts authenticates and loads the file.
  if (mode === "production" && source === process.env && !hasLoadedSecretEnvironment(source)) {
    throw new ConfigurationError(
      "CAPSTONE_SECRET_FILE",
      "CAPSTONE_SECRET_FILE must be the exclusive source of production credentials",
    );
  }
}

function readRequired(
  source: NodeJS.ProcessEnv,
  key: "BETTER_AUTH_SECRET" | "DATABASE_URL" | "PUBLIC_ORIGIN",
  fallback: string | undefined,
): string {
  const value = source[key]?.trim() || fallback;

  if (value === undefined) {
    throw new ConfigurationError(key, `${key} is required in production`);
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
    throw new ConfigurationError(
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_SECRET must contain at least 32 characters",
    );
  }

  return secret;
}

function readEmailDelivery(value: string | undefined, mode: RuntimeMode): EmailDelivery {
  const delivery = value?.trim() || (mode === "production" ? undefined : "fake");

  if (delivery === undefined) {
    throw new ConfigurationError("EMAIL_DELIVERY", "EMAIL_DELIVERY is required in production");
  }

  if (delivery !== "fake" && delivery !== "disabled" && delivery !== "resend") {
    throw new ConfigurationError(
      "EMAIL_DELIVERY",
      "EMAIL_DELIVERY must be disabled, fake, or resend",
    );
  }

  if (mode === "production" && delivery !== "resend") {
    throw new ConfigurationError("EMAIL_DELIVERY", "EMAIL_DELIVERY must be resend in production");
  }

  return delivery;
}

function readResendConfig(
  source: NodeJS.ProcessEnv,
  delivery: EmailDelivery,
): Readonly<{ emailFrom: string | null; resendApiKey: string | null }> {
  if (delivery !== "resend") {
    return Object.freeze({ emailFrom: null, resendApiKey: null });
  }

  const resendApiKey = source.RESEND_API_KEY?.trim();
  if (resendApiKey === undefined || resendApiKey.length === 0) {
    throw new ConfigurationError(
      "RESEND_API_KEY",
      "RESEND_API_KEY is required when EMAIL_DELIVERY=resend",
    );
  }

  const emailFrom = source.EMAIL_FROM?.trim();
  if (emailFrom === undefined || emailFrom.length === 0) {
    throw new ConfigurationError("EMAIL_FROM", "EMAIL_FROM is required when EMAIL_DELIVERY=resend");
  }
  if (emailFrom !== productionSender) {
    throw new ConfigurationError("EMAIL_FROM", "EMAIL_FROM must use the approved Capstone sender");
  }

  return Object.freeze({ emailFrom, resendApiKey });
}

function readHost(value: string | undefined, mode: RuntimeMode): string {
  const host = value?.trim() || (mode === "production" ? undefined : developmentDefaults.host);

  if (host === undefined || host.length === 0 || /\s/u.test(host)) {
    throw new ConfigurationError("HOST", "HOST must be a non-empty hostname or IP address");
  }
  if (mode === "production" && host !== "127.0.0.1") {
    throw new ConfigurationError("HOST", "HOST must be 127.0.0.1 in production");
  }

  return host;
}

function readClientAddressSource(
  value: string | undefined,
  mode: RuntimeMode,
): ClientAddressSource {
  const source = value?.trim() || (mode === "production" ? undefined : "socket");
  if (source !== "caddy" && source !== "socket") {
    throw new ConfigurationError(
      "CLIENT_ADDRESS_SOURCE",
      "CLIENT_ADDRESS_SOURCE must be caddy or socket",
    );
  }
  if (mode === "production" && source !== "caddy") {
    throw new ConfigurationError(
      "CLIENT_ADDRESS_SOURCE",
      "CLIENT_ADDRESS_SOURCE must be caddy in production",
    );
  }
  return source;
}

function readPort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return developmentDefaults.port;
  }

  if (!/^\d+$/u.test(value)) {
    throw new ConfigurationError("PORT", "PORT must be an integer from 1 to 65535");
  }

  const port = Number(value);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError("PORT", "PORT must be an integer from 1 to 65535");
  }

  return port;
}

function readDatabaseUrl(value: string, mode: RuntimeMode): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("DATABASE_URL", "DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new ConfigurationError(
      "DATABASE_URL",
      "DATABASE_URL must use the postgres or postgresql protocol",
    );
  }

  if (mode === "production") {
    if (parseProductionDatabaseUrl(value) === null) {
      throw new ConfigurationError(
        "DATABASE_URL",
        "DATABASE_URL must use credentials, a DNS host, direct port 5432, and exactly one verify-full platform-trusted TLS setting in production",
      );
    }
  }

  return value;
}

function readPublicOrigin(value: string, mode: RuntimeMode): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("PUBLIC_ORIGIN", "PUBLIC_ORIGIN must be a valid HTTP origin");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigurationError(
      "PUBLIC_ORIGIN",
      "PUBLIC_ORIGIN must use the http or https protocol",
    );
  }

  if (mode === "production" && url.protocol !== "https:") {
    throw new ConfigurationError("PUBLIC_ORIGIN", "PUBLIC_ORIGIN must use https in production");
  }

  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ConfigurationError("PUBLIC_ORIGIN", "PUBLIC_ORIGIN must contain only an origin");
  }

  if (mode === "production" && url.origin !== productionOrigin) {
    throw new ConfigurationError(
      "PUBLIC_ORIGIN",
      "PUBLIC_ORIGIN must use the approved production origin",
    );
  }

  return url.origin;
}

function readDeploymentRevision(source: NodeJS.ProcessEnv, mode: RuntimeMode): string {
  if (mode === "production") {
    const revision = source.DEPLOYMENT_REVISION?.trim();
    if (revision === undefined || revision.length === 0) {
      throw new ConfigurationError(
        "DEPLOYMENT_REVISION",
        "DEPLOYMENT_REVISION is required in production",
      );
    }
    if (!/^[0-9a-f]{40}$/iu.test(revision)) {
      throw new ConfigurationError(
        "DEPLOYMENT_REVISION",
        "DEPLOYMENT_REVISION must be a full Git commit identifier",
      );
    }
    return revision.toLowerCase();
  }

  const revision = source.DEPLOYMENT_REVISION?.trim() || mode;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(revision)) {
    throw new ConfigurationError(
      "DEPLOYMENT_REVISION",
      "DEPLOYMENT_REVISION must be a safe bounded release identifier",
    );
  }
  return revision;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
}

function readOtlpConfig(
  source: NodeJS.ProcessEnv,
  mode: RuntimeMode,
): Readonly<{
  endpoint: string | null;
  headers: Readonly<Record<string, string>>;
}> {
  const endpointValue = source.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const headersValue = source.OTEL_EXPORTER_OTLP_HEADERS?.trim();
  const required =
    mode === "production" || endpointValue !== undefined || headersValue !== undefined;

  if (!required) {
    return Object.freeze({ endpoint: null, headers: Object.freeze({}) });
  }
  if (endpointValue === undefined || endpointValue.length === 0) {
    throw new ConfigurationError(
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_ENDPOINT is required with telemetry",
    );
  }
  if (headersValue === undefined || headersValue.length === 0) {
    throw new ConfigurationError(
      "OTEL_EXPORTER_OTLP_HEADERS",
      "OTEL_EXPORTER_OTLP_HEADERS is required with telemetry",
    );
  }

  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new ConfigurationError(
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_ENDPOINT must be a valid HTTPS base URL",
    );
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new ConfigurationError(
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_ENDPOINT must be an HTTPS origin",
    );
  }
  if (!/^otlp(?:\.[a-z0-9-]+)?\.nr-data\.net$/u.test(endpoint.hostname)) {
    throw new ConfigurationError(
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_ENDPOINT must use an official New Relic OTLP host",
    );
  }

  const separator = headersValue.indexOf("=");
  const apiKey = separator === -1 ? "" : headersValue.slice(separator + 1).trim();
  if (
    headersValue.slice(0, separator).trim() !== "api-key" ||
    apiKey.length === 0 ||
    headersValue.includes(",") ||
    containsControlCharacter(apiKey)
  ) {
    throw new ConfigurationError(
      "OTEL_EXPORTER_OTLP_HEADERS",
      "OTEL_EXPORTER_OTLP_HEADERS must contain exactly one api-key header",
    );
  }

  return Object.freeze({
    endpoint: endpoint.origin,
    headers: Object.freeze({ "api-key": apiKey }),
  });
}

function readLogLevel(value: string | undefined, mode: RuntimeMode): LogLevel {
  const level = value?.trim() || (mode === "test" ? "silent" : "info");

  if (!isIncluded(logLevels, level)) {
    throw new ConfigurationError("LOG_LEVEL", "LOG_LEVEL is not supported");
  }

  return level;
}

function readModelGateway(value: string | undefined, mode: RuntimeMode): ModelGatewayMode {
  const gateway = value?.trim() || (mode === "production" ? undefined : "fake");

  if (gateway === undefined) {
    throw new ConfigurationError("MODEL_GATEWAY", "MODEL_GATEWAY is required in production");
  }
  if (gateway !== "fake" && gateway !== "openrouter") {
    throw new ConfigurationError("MODEL_GATEWAY", "MODEL_GATEWAY must be fake or openrouter");
  }
  if (mode === "production" && gateway === "fake") {
    throw new ConfigurationError("MODEL_GATEWAY", "MODEL_GATEWAY=fake is prohibited in production");
  }
  return gateway;
}

function readOpenRouterApiKey(value: string | undefined, gateway: ModelGatewayMode): string | null {
  if (gateway === "fake") {
    return null;
  }
  const apiKey = value?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new ConfigurationError(
      "OPENROUTER_API_KEY",
      "OPENROUTER_API_KEY is required when MODEL_GATEWAY=openrouter",
    );
  }
  return apiKey;
}

function readDatabaseConfig(
  source: NodeJS.ProcessEnv,
  nodeEnv: RuntimeMode,
): Readonly<DatabaseConfig> {
  const allowDevelopmentDefaults = nodeEnv !== "production";
  const databaseUrl = readDatabaseUrl(
    readRequired(
      source,
      "DATABASE_URL",
      allowDevelopmentDefaults ? developmentDefaults.databaseUrl : undefined,
    ),
    nodeEnv,
  );

  return Object.freeze({ databaseUrl });
}

export function loadDatabaseConfig(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<DatabaseConfig> {
  const nodeEnv = readRuntimeMode(source.NODE_ENV);
  requireProductionSecretFile(source, nodeEnv);
  return readDatabaseConfig(source, nodeEnv);
}

export function loadOpenRouterOperatorConfig(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<OpenRouterOperatorConfig> {
  const nodeEnv = readRuntimeMode(source.NODE_ENV);
  requireProductionSecretFile(source, nodeEnv);
  const apiKey = readOpenRouterApiKey(source.OPENROUTER_API_KEY, "openrouter");
  if (apiKey === null) {
    throw new ConfigurationError(
      "OPENROUTER_API_KEY",
      "OPENROUTER_API_KEY is required for OpenRouter operator commands",
    );
  }
  return Object.freeze({ apiKey });
}

export function loadIdentityOperatorConfig(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<IdentityOperatorConfig> {
  const nodeEnv = readRuntimeMode(source.NODE_ENV);
  requireProductionSecretFile(source, nodeEnv);
  const { databaseUrl } = readDatabaseConfig(source, nodeEnv);
  const publicOrigin = readPublicOrigin(
    readRequired(
      source,
      "PUBLIC_ORIGIN",
      nodeEnv === "production" ? undefined : developmentDefaults.publicOrigin,
    ),
    nodeEnv,
  );
  const emailDelivery = readEmailDelivery(source.EMAIL_DELIVERY, nodeEnv);
  const resend = readResendConfig(source, emailDelivery);

  return Object.freeze({
    authSecret: readAuthSecret(source, nodeEnv),
    databaseUrl,
    emailDelivery,
    emailFrom: resend.emailFrom,
    nodeEnv,
    publicOrigin,
    resendApiKey: resend.resendApiKey,
  });
}

export function loadRecoveryPreparationOperatorConfig(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<RecoveryPreparationOperatorConfig> {
  const nodeEnv = readRuntimeMode(source.NODE_ENV);
  requireProductionSecretFile(source, nodeEnv);
  const migrationSecretFilePath = source.CAPSTONE_SECRET_FILE?.trim();
  if (migrationSecretFilePath === undefined || migrationSecretFilePath.length === 0) {
    throw new ConfigurationError(
      "CAPSTONE_SECRET_FILE",
      "CAPSTONE_SECRET_FILE is required for recovery preparation",
    );
  }
  return Object.freeze({
    ...readDatabaseConfig(source, nodeEnv),
    migrationSecretFilePath,
  });
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Readonly<ApiConfig> {
  const nodeEnv = readRuntimeMode(source.NODE_ENV);
  requireProductionSecretFile(source, nodeEnv);
  const { databaseUrl } = readDatabaseConfig(source, nodeEnv);
  const allowDevelopmentDefaults = nodeEnv !== "production";
  const publicOrigin = readPublicOrigin(
    readRequired(
      source,
      "PUBLIC_ORIGIN",
      allowDevelopmentDefaults ? developmentDefaults.publicOrigin : undefined,
    ),
    nodeEnv,
  );
  const modelGateway = readModelGateway(source.MODEL_GATEWAY, nodeEnv);
  const emailDelivery = readEmailDelivery(source.EMAIL_DELIVERY, nodeEnv);
  const resend = readResendConfig(source, emailDelivery);
  const otlp = readOtlpConfig(source, nodeEnv);

  return Object.freeze({
    authSecret: readAuthSecret(source, nodeEnv),
    clientAddressSource: readClientAddressSource(source.CLIENT_ADDRESS_SOURCE, nodeEnv),
    databaseUrl,
    deploymentRevision: readDeploymentRevision(source, nodeEnv),
    emailDelivery,
    emailFrom: resend.emailFrom,
    host: readHost(source.HOST, nodeEnv),
    logLevel: readLogLevel(source.LOG_LEVEL, nodeEnv),
    modelGateway,
    nodeEnv,
    openRouterApiKey: readOpenRouterApiKey(source.OPENROUTER_API_KEY, modelGateway),
    otlpEndpoint: otlp.endpoint,
    otlpHeaders: otlp.headers,
    port: readPort(source.PORT),
    publicOrigin,
    resendApiKey: resend.resendApiKey,
    trustProxy: false,
    webAssetsDirectory: nodeEnv === "production" ? productionWebAssetsDirectory : null,
  });
}

export function publicConfigMetadata(config: ApiConfig): Readonly<Record<string, unknown>> {
  return Object.freeze({
    clientAddressSource: config.clientAddressSource,
    emailDelivery: config.emailDelivery,
    deploymentRevision: config.deploymentRevision,
    host: config.host,
    logLevel: config.logLevel,
    modelGateway: config.modelGateway,
    nodeEnv: config.nodeEnv,
    port: config.port,
    publicOrigin: config.publicOrigin,
    trustProxy: config.trustProxy,
    telemetry: config.otlpEndpoint !== null,
    webAssets: config.webAssetsDirectory !== null,
  });
}
