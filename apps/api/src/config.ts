import { fileURLToPath } from "node:url";
import {
  assertProductionDatabaseCredentialBoundary,
  parseProductionDatabaseUrl,
} from "./database/production-database-url.js";
import { hasLoadedSecretEnvironment } from "./secret-environment.js";

const runtimeModes = ["development", "test", "production"] as const;
const applicationEnvironments = ["development", "staging", "production"] as const;
const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type RuntimeMode = (typeof runtimeModes)[number];
export type ApplicationEnvironment = (typeof applicationEnvironments)[number];
export type LogLevel = (typeof logLevels)[number];
export type EmailDelivery = "disabled" | "fake" | "resend";
export type ModelGatewayMode = "fake" | "openrouter";
export type ClientAddressSource = "digitalocean-app-platform" | "socket";

const configurationKeys = [
  "BETTER_AUTH_SECRET",
  "CAPSTONE_BOOTSTRAP_DATABASE_URL",
  "CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL",
  "CAPSTONE_ENVIRONMENT",
  "CAPSTONE_INITIALIZATION_DOCUMENT",
  "CAPSTONE_INITIALIZATION_SCHEMA_VERSION",
  "CAPSTONE_SECRET_FILE",
  "CAPSTONE_STAGING_EMAIL_RECIPIENTS",
  "DATABASE_URL",
  "DEPLOYMENT_REVISION",
  "EMAIL_DELIVERY",
  "EMAIL_FROM",
  "HOST",
  "LOG_LEVEL",
  "MODEL_GATEWAY",
  "NODE_ENV",
  "OPENROUTER_API_KEY",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "PORT",
  "PUBLIC_ORIGIN",
  "RESEND_API_KEY",
] as const;
const configurationKeySet = new Set<string>(configurationKeys);
export type ConfigurationKey = (typeof configurationKeys)[number];

export function isConfigurationKey(value: unknown): value is ConfigurationKey {
  return typeof value === "string" && configurationKeySet.has(value);
}

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
  readonly applicationEnvironment: ApplicationEnvironment;
  readonly authSecret: string;
  readonly emailDelivery: EmailDelivery;
  readonly emailFrom: string | null;
  readonly nodeEnv: RuntimeMode;
  readonly publicOrigin: string;
  readonly resendApiKey: string | null;
  readonly stagingEmailRecipients: readonly string[];
}

export interface RecoveryPreparationOperatorConfig extends DatabaseConfig {
  readonly migrationSecretFilePath: string;
}

export interface HealthBootstrapConfig {
  readonly applicationEnvironment: "staging" | "production";
  readonly deploymentRevision: string;
  readonly host: "0.0.0.0";
  readonly nodeEnv: "production";
  readonly port: 3000;
}

export interface InitializationOperatorConfig {
  readonly applicationDatabaseUrl: string;
  readonly applicationEnvironment: "staging" | "production";
  readonly deploymentRevision: string;
  readonly initializationDocument: string;
  readonly initializationSchemaVersion: 1;
  readonly migrationDatabaseUrl: string;
  readonly modelGateway: "openrouter";
  readonly nodeEnv: "production";
  readonly openRouterApiKey: string;
}

export interface ApiConfig {
  readonly applicationEnvironment: ApplicationEnvironment;
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
  readonly stagingEmailRecipients: readonly string[];
  readonly trustProxy: false;
  readonly webAssetsDirectory: string | null;
}

const stagingOrigin = "https://staging.chat.capstone.com.ec";
const productionOrigin = "https://chat.capstone.com.ec";
const stagingSender = "Capstone Chat Staging <no-reply@staging.mail.capstone.com.ec>";
const productionSender = "Capstone Chat <no-reply@mail.capstone.com.ec>";
const productionWebAssetsDirectory = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const initializationDocumentMaximumBytes = 32 * 1_024;

const developmentDefaults = {
  authSecret: "capstone-chat-local-auth-secret-not-for-production-use",
  databaseUrl: "postgresql://capstone:capstone@127.0.0.1:5432/capstone_chat",
  host: "127.0.0.1",
  port: 3000,
  publicOrigin: "http://localhost:5173",
} as const;

function included<const T extends string>(values: readonly T[], value: string): value is T {
  return values.some((candidate) => candidate === value);
}

function readRuntimeMode(value: string | undefined): RuntimeMode {
  const mode = value?.trim() || "development";
  if (!included(runtimeModes, mode)) {
    throw new ConfigurationError("NODE_ENV", "NODE_ENV must be development, test, or production");
  }
  return mode;
}

function readApplicationEnvironment(
  value: string | undefined,
  nodeEnv: RuntimeMode,
): ApplicationEnvironment {
  const configured = value?.trim();
  const environment = configured || (nodeEnv === "production" ? undefined : "development");
  if (environment === undefined) {
    throw new ConfigurationError(
      "CAPSTONE_ENVIRONMENT",
      "CAPSTONE_ENVIRONMENT is required when NODE_ENV=production",
    );
  }
  if (!included(applicationEnvironments, environment)) {
    throw new ConfigurationError(
      "CAPSTONE_ENVIRONMENT",
      "CAPSTONE_ENVIRONMENT must be development, staging, or production",
    );
  }
  if (environment === "development" && nodeEnv === "production") {
    throw new ConfigurationError(
      "CAPSTONE_ENVIRONMENT",
      "CAPSTONE_ENVIRONMENT=development requires a non-production NODE_ENV",
    );
  }
  if (environment !== "development" && nodeEnv !== "production") {
    throw new ConfigurationError(
      "NODE_ENV",
      `NODE_ENV must be production when CAPSTONE_ENVIRONMENT=${environment}`,
    );
  }
  return environment;
}

function readEnvironment(source: NodeJS.ProcessEnv): Readonly<{
  applicationEnvironment: ApplicationEnvironment;
  nodeEnv: RuntimeMode;
}> {
  const nodeEnv = readRuntimeMode(source.NODE_ENV);
  return Object.freeze({
    applicationEnvironment: readApplicationEnvironment(source.CAPSTONE_ENVIRONMENT, nodeEnv),
    nodeEnv,
  });
}

function readNormalEnvironment(source: NodeJS.ProcessEnv): Readonly<{
  applicationEnvironment: ApplicationEnvironment;
  nodeEnv: RuntimeMode;
}> {
  const environment = readEnvironment(source);
  if (hosted(environment.applicationEnvironment) && source.CAPSTONE_SECRET_FILE?.trim()) {
    throw new ConfigurationError(
      "CAPSTONE_SECRET_FILE",
      "CAPSTONE_SECRET_FILE is prohibited in hosted components outside recovery preparation",
    );
  }
  return environment;
}

function hosted(environment: ApplicationEnvironment): environment is "staging" | "production" {
  return environment !== "development";
}

function readRequired(
  source: NodeJS.ProcessEnv,
  key:
    | "BETTER_AUTH_SECRET"
    | "CAPSTONE_BOOTSTRAP_DATABASE_URL"
    | "CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL"
    | "DATABASE_URL"
    | "PUBLIC_ORIGIN",
  fallback?: string,
): string {
  const value = source[key]?.trim() || fallback;
  if (value === undefined) {
    throw new ConfigurationError(key, `${key} is required for hosted operation`);
  }
  return value;
}

function readAuthSecret(source: NodeJS.ProcessEnv, environment: ApplicationEnvironment): string {
  const secret = readRequired(
    source,
    "BETTER_AUTH_SECRET",
    environment === "development" ? developmentDefaults.authSecret : undefined,
  );
  if (secret.length < 32) {
    throw new ConfigurationError(
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_SECRET must contain at least 32 characters",
    );
  }
  return secret;
}

function readEmailDelivery(
  value: string | undefined,
  environment: ApplicationEnvironment,
): EmailDelivery {
  const delivery = value?.trim() || (environment === "development" ? "fake" : undefined);
  if (delivery !== "disabled" && delivery !== "fake" && delivery !== "resend") {
    throw new ConfigurationError(
      "EMAIL_DELIVERY",
      "EMAIL_DELIVERY must be disabled, fake, or resend",
    );
  }
  if (hosted(environment) && delivery !== "resend") {
    throw new ConfigurationError("EMAIL_DELIVERY", "EMAIL_DELIVERY must be resend when hosted");
  }
  if (environment === "development" && delivery === "resend") {
    throw new ConfigurationError(
      "EMAIL_DELIVERY",
      "Development email must use the fake mailbox or be disabled",
    );
  }
  return delivery;
}

function readResendConfig(
  source: NodeJS.ProcessEnv,
  delivery: EmailDelivery,
  environment: ApplicationEnvironment,
): Readonly<{ emailFrom: string | null; resendApiKey: string | null }> {
  if (delivery !== "resend") {
    return Object.freeze({ emailFrom: null, resendApiKey: null });
  }
  const resendApiKey = source.RESEND_API_KEY?.trim();
  if (!resendApiKey) {
    throw new ConfigurationError(
      "RESEND_API_KEY",
      "RESEND_API_KEY is required when EMAIL_DELIVERY=resend",
    );
  }
  const emailFrom = source.EMAIL_FROM?.trim();
  const expected = environment === "staging" ? stagingSender : productionSender;
  if (emailFrom !== expected) {
    throw new ConfigurationError(
      "EMAIL_FROM",
      `EMAIL_FROM must use the approved ${environment} sender`,
    );
  }
  return Object.freeze({ emailFrom, resendApiKey });
}

function normalizedEmail(value: string): string {
  return value.trim().normalize("NFC").toLowerCase();
}

function readStagingEmailRecipients(
  value: string | undefined,
  environment: ApplicationEnvironment,
): readonly string[] {
  const configured = value?.trim();
  if (environment !== "staging") {
    if (configured) {
      throw new ConfigurationError(
        "CAPSTONE_STAGING_EMAIL_RECIPIENTS",
        "CAPSTONE_STAGING_EMAIL_RECIPIENTS is permitted only in staging",
      );
    }
    return Object.freeze([]);
  }
  if (!configured) {
    throw new ConfigurationError(
      "CAPSTONE_STAGING_EMAIL_RECIPIENTS",
      "CAPSTONE_STAGING_EMAIL_RECIPIENTS must contain 1 to 10 addresses",
    );
  }
  const entries = value?.split(",") ?? [];
  if (entries.length < 1 || entries.length > 10) {
    throw new ConfigurationError(
      "CAPSTONE_STAGING_EMAIL_RECIPIENTS",
      "CAPSTONE_STAGING_EMAIL_RECIPIENTS must contain 1 to 10 addresses",
    );
  }
  const recipients = entries.map((entry) => normalizedEmail(entry));
  if (
    recipients.some(
      (recipient, index) =>
        recipient !== entries[index] ||
        recipient.length > 254 ||
        !/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(recipient),
    ) ||
    new Set(recipients).size !== recipients.length
  ) {
    throw new ConfigurationError(
      "CAPSTONE_STAGING_EMAIL_RECIPIENTS",
      "CAPSTONE_STAGING_EMAIL_RECIPIENTS must contain unique normalized addresses",
    );
  }
  return Object.freeze(recipients);
}

function readHost(value: string | undefined, environment: ApplicationEnvironment): string {
  const selected =
    value?.trim() || (environment === "development" ? developmentDefaults.host : undefined);
  if (!selected || /\s/u.test(selected)) {
    throw new ConfigurationError("HOST", "HOST must be a non-empty hostname or IP address");
  }
  if (hosted(environment) && selected !== "0.0.0.0") {
    throw new ConfigurationError("HOST", "HOST must be 0.0.0.0 when hosted");
  }
  return selected;
}

function readPort(value: string | undefined, environment: ApplicationEnvironment): number {
  const configured = value?.trim();
  if (!configured) {
    return developmentDefaults.port;
  }
  if (!/^\d+$/u.test(configured)) {
    throw new ConfigurationError("PORT", "PORT must be an integer from 1 to 65535");
  }
  const port = Number(configured);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError("PORT", "PORT must be an integer from 1 to 65535");
  }
  if (hosted(environment) && port !== 3_000) {
    throw new ConfigurationError("PORT", "PORT must be 3000 when hosted");
  }
  return port;
}

function readDatabaseUrl(value: string, environment: ApplicationEnvironment): string {
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
  if (hosted(environment) && parseProductionDatabaseUrl(value) === null) {
    throw new ConfigurationError(
      "DATABASE_URL",
      "Hosted DATABASE_URL must use credentials, a DNS host, direct port 5432, and exactly one verify-full platform-trusted TLS setting",
    );
  }
  return value;
}

function readDatabaseConfig(
  source: NodeJS.ProcessEnv,
  environment: ApplicationEnvironment,
): Readonly<DatabaseConfig> {
  return Object.freeze({
    databaseUrl: readDatabaseUrl(
      readRequired(
        source,
        "DATABASE_URL",
        environment === "development" ? developmentDefaults.databaseUrl : undefined,
      ),
      environment,
    ),
  });
}

function readPublicOrigin(value: string, environment: ApplicationEnvironment): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError("PUBLIC_ORIGIN", "PUBLIC_ORIGIN must be a valid HTTP origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ConfigurationError("PUBLIC_ORIGIN", "PUBLIC_ORIGIN must contain only an HTTP origin");
  }
  const expected = environment === "staging" ? stagingOrigin : productionOrigin;
  if (hosted(environment) && url.origin !== expected) {
    throw new ConfigurationError(
      "PUBLIC_ORIGIN",
      `PUBLIC_ORIGIN must use the approved ${environment} origin`,
    );
  }
  if (
    environment === "development" &&
    (url.origin === stagingOrigin ||
      url.origin === productionOrigin ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  ) {
    throw new ConfigurationError("PUBLIC_ORIGIN", "Development PUBLIC_ORIGIN must be loopback");
  }
  return url.origin;
}

function readDeploymentRevision(
  source: NodeJS.ProcessEnv,
  environment: ApplicationEnvironment,
): string {
  const revision = source.DEPLOYMENT_REVISION?.trim();
  if (hosted(environment)) {
    if (!revision || !/^[0-9a-f]{40}$/iu.test(revision)) {
      throw new ConfigurationError(
        "DEPLOYMENT_REVISION",
        "DEPLOYMENT_REVISION must be a full Git commit identifier when hosted",
      );
    }
    return revision.toLowerCase();
  }
  const developmentRevision =
    revision || (source.NODE_ENV?.trim() === "test" ? "test" : "development");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(developmentRevision)) {
    throw new ConfigurationError(
      "DEPLOYMENT_REVISION",
      "DEPLOYMENT_REVISION must be a safe bounded release identifier",
    );
  }
  return developmentRevision;
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
  environment: ApplicationEnvironment,
): Readonly<{ endpoint: string | null; headers: Readonly<Record<string, string>> }> {
  const endpointValue = source.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const headersValue = source.OTEL_EXPORTER_OTLP_HEADERS?.trim();
  if (!hosted(environment) && !endpointValue && !headersValue) {
    return Object.freeze({ endpoint: null, headers: Object.freeze({}) });
  }
  if (!endpointValue || !headersValue) {
    throw new ConfigurationError(
      endpointValue ? "OTEL_EXPORTER_OTLP_HEADERS" : "OTEL_EXPORTER_OTLP_ENDPOINT",
      "Both New Relic OTLP settings are required with telemetry",
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new ConfigurationError(
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_ENDPOINT must be a valid HTTPS origin",
    );
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    !["https://otlp.nr-data.net", "https://otlp.eu01.nr-data.net"].includes(endpoint.origin)
  ) {
    throw new ConfigurationError(
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_ENDPOINT must select the exact US or EU New Relic OTLP origin",
    );
  }
  const separator = headersValue.indexOf("=");
  const apiKey = separator === -1 ? "" : headersValue.slice(separator + 1).trim();
  if (
    headersValue.slice(0, separator).trim() !== "api-key" ||
    !apiKey ||
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

function readLogLevel(value: string | undefined, nodeEnv: RuntimeMode): LogLevel {
  const level = value?.trim() || (nodeEnv === "test" ? "silent" : "info");
  if (!included(logLevels, level)) {
    throw new ConfigurationError("LOG_LEVEL", "LOG_LEVEL is not supported");
  }
  return level;
}

function readModelGateway(
  value: string | undefined,
  environment: ApplicationEnvironment,
): ModelGatewayMode {
  const gateway = value?.trim() || (environment === "development" ? "fake" : undefined);
  if (gateway !== "fake" && gateway !== "openrouter") {
    throw new ConfigurationError("MODEL_GATEWAY", "MODEL_GATEWAY must be fake or openrouter");
  }
  if (hosted(environment) && gateway !== "openrouter") {
    throw new ConfigurationError("MODEL_GATEWAY", "MODEL_GATEWAY must be openrouter when hosted");
  }
  return gateway;
}

function readOpenRouterApiKey(value: string | undefined, gateway: ModelGatewayMode): string | null {
  if (gateway === "fake") {
    return null;
  }
  const apiKey = value?.trim();
  if (!apiKey) {
    throw new ConfigurationError(
      "OPENROUTER_API_KEY",
      "OPENROUTER_API_KEY is required when MODEL_GATEWAY=openrouter",
    );
  }
  return apiKey;
}

function rejectConfiguredKeys(
  source: NodeJS.ProcessEnv,
  keys: readonly ConfigurationKey[],
  message: string,
): void {
  for (const key of keys) {
    if (source[key] !== undefined) {
      throw new ConfigurationError(key, message);
    }
  }
}

function rejectConfigurationOutside(
  source: NodeJS.ProcessEnv,
  allowed: ReadonlySet<ConfigurationKey>,
  message: string,
): void {
  for (const key of configurationKeys) {
    if (!allowed.has(key) && source[key] !== undefined) {
      throw new ConfigurationError(key, message);
    }
  }
}

function requireOfflineRecoverySecretFile(source: NodeJS.ProcessEnv, nodeEnv: RuntimeMode): void {
  if (nodeEnv === "production" && source === process.env && !hasLoadedSecretEnvironment(source)) {
    throw new ConfigurationError(
      "CAPSTONE_SECRET_FILE",
      "CAPSTONE_SECRET_FILE must be the authenticated offline recovery credential source",
    );
  }
}

export function loadDatabaseConfig(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<DatabaseConfig> {
  const environment = readNormalEnvironment(source);
  if (hosted(environment.applicationEnvironment)) {
    rejectConfiguredKeys(
      source,
      [
        "BETTER_AUTH_SECRET",
        "CAPSTONE_BOOTSTRAP_DATABASE_URL",
        "CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL",
        "CAPSTONE_INITIALIZATION_DOCUMENT",
        "CAPSTONE_INITIALIZATION_SCHEMA_VERSION",
        "OPENROUTER_API_KEY",
        "OTEL_EXPORTER_OTLP_HEADERS",
        "RESEND_API_KEY",
      ],
      "The database operator cannot receive application or initialization credentials",
    );
  }
  return readDatabaseConfig(source, environment.applicationEnvironment);
}

export function loadOpenRouterOperatorConfig(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<OpenRouterOperatorConfig> {
  readNormalEnvironment(source);
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
  const environment = readNormalEnvironment(source);
  const emailDelivery = readEmailDelivery(
    source.EMAIL_DELIVERY,
    environment.applicationEnvironment,
  );
  const resend = readResendConfig(source, emailDelivery, environment.applicationEnvironment);
  return Object.freeze({
    applicationEnvironment: environment.applicationEnvironment,
    authSecret: readAuthSecret(source, environment.applicationEnvironment),
    ...readDatabaseConfig(source, environment.applicationEnvironment),
    emailDelivery,
    emailFrom: resend.emailFrom,
    nodeEnv: environment.nodeEnv,
    publicOrigin: readPublicOrigin(
      readRequired(
        source,
        "PUBLIC_ORIGIN",
        environment.applicationEnvironment === "development"
          ? developmentDefaults.publicOrigin
          : undefined,
      ),
      environment.applicationEnvironment,
    ),
    resendApiKey: resend.resendApiKey,
    stagingEmailRecipients: readStagingEmailRecipients(
      source.CAPSTONE_STAGING_EMAIL_RECIPIENTS,
      environment.applicationEnvironment,
    ),
  });
}

export function loadRecoveryPreparationOperatorConfig(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<RecoveryPreparationOperatorConfig> {
  const environment = readEnvironment(source);
  requireOfflineRecoverySecretFile(source, environment.nodeEnv);
  const migrationSecretFilePath = source.CAPSTONE_SECRET_FILE?.trim();
  if (!migrationSecretFilePath) {
    throw new ConfigurationError(
      "CAPSTONE_SECRET_FILE",
      "CAPSTONE_SECRET_FILE is required for recovery preparation",
    );
  }
  return Object.freeze({
    ...readDatabaseConfig(source, environment.applicationEnvironment),
    migrationSecretFilePath,
  });
}

const migrationConfigurationKeys = new Set<ConfigurationKey>([
  "CAPSTONE_ENVIRONMENT",
  "DATABASE_URL",
  "DEPLOYMENT_REVISION",
  "NODE_ENV",
]);

export function loadMigrationConfig(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<DatabaseConfig> {
  const environment = readNormalEnvironment(source);
  if (hosted(environment.applicationEnvironment)) {
    rejectConfigurationOutside(
      source,
      migrationConfigurationKeys,
      "The migration job cannot receive application, provider, telemetry, or initialization configuration",
    );
    readDeploymentRevision(source, environment.applicationEnvironment);
  }
  return readDatabaseConfig(source, environment.applicationEnvironment);
}

export function loadHealthBootstrapConfig(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<HealthBootstrapConfig> {
  const environment = readNormalEnvironment(source);
  if (!hosted(environment.applicationEnvironment)) {
    throw new ConfigurationError(
      "CAPSTONE_ENVIRONMENT",
      "The health bootstrap is available only for hosted environments",
    );
  }
  rejectConfigurationOutside(
    source,
    new Set<ConfigurationKey>([
      "CAPSTONE_ENVIRONMENT",
      "DEPLOYMENT_REVISION",
      "HOST",
      "NODE_ENV",
      "PORT",
    ]),
    "The health bootstrap cannot receive runtime secrets or unrelated configuration",
  );
  const host = readHost(source.HOST, environment.applicationEnvironment);
  const port = readPort(source.PORT, environment.applicationEnvironment);
  if (environment.nodeEnv !== "production" || host !== "0.0.0.0" || port !== 3_000) {
    throw new ConfigurationError(
      "CAPSTONE_ENVIRONMENT",
      "The health bootstrap requires exact hosted runtime policy",
    );
  }
  return Object.freeze({
    applicationEnvironment: environment.applicationEnvironment,
    deploymentRevision: readDeploymentRevision(source, environment.applicationEnvironment),
    host,
    nodeEnv: environment.nodeEnv,
    port,
  });
}

export function loadInitializationOperatorConfig(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<InitializationOperatorConfig> {
  const environment = readNormalEnvironment(source);
  if (!hosted(environment.applicationEnvironment)) {
    throw new ConfigurationError(
      "CAPSTONE_ENVIRONMENT",
      "Initialization is available only for hosted environments",
    );
  }
  rejectConfigurationOutside(
    source,
    new Set<ConfigurationKey>([
      "CAPSTONE_BOOTSTRAP_DATABASE_URL",
      "CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL",
      "CAPSTONE_ENVIRONMENT",
      "CAPSTONE_INITIALIZATION_DOCUMENT",
      "CAPSTONE_INITIALIZATION_SCHEMA_VERSION",
      "DEPLOYMENT_REVISION",
      "MODEL_GATEWAY",
      "NODE_ENV",
      "OPENROUTER_API_KEY",
    ]),
    "The initialization job cannot receive steady application credentials or configuration",
  );
  const schemaVersion = source.CAPSTONE_INITIALIZATION_SCHEMA_VERSION?.trim();
  if (schemaVersion !== "1") {
    throw new ConfigurationError(
      "CAPSTONE_INITIALIZATION_SCHEMA_VERSION",
      "CAPSTONE_INITIALIZATION_SCHEMA_VERSION must be 1",
    );
  }
  const initializationDocument = source.CAPSTONE_INITIALIZATION_DOCUMENT;
  if (
    !initializationDocument?.trim() ||
    Buffer.byteLength(initializationDocument, "utf8") > initializationDocumentMaximumBytes
  ) {
    throw new ConfigurationError(
      "CAPSTONE_INITIALIZATION_DOCUMENT",
      "CAPSTONE_INITIALIZATION_DOCUMENT must contain at most 32768 UTF-8 bytes",
    );
  }
  const applicationDatabaseUrl = readDatabaseUrl(
    readRequired(source, "CAPSTONE_BOOTSTRAP_DATABASE_URL"),
    environment.applicationEnvironment,
  );
  const migrationDatabaseUrl = readDatabaseUrl(
    readRequired(source, "CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL"),
    environment.applicationEnvironment,
  );
  assertProductionDatabaseCredentialBoundary(migrationDatabaseUrl, applicationDatabaseUrl);
  const modelGateway = readModelGateway(source.MODEL_GATEWAY, environment.applicationEnvironment);
  const openRouterApiKey = readOpenRouterApiKey(source.OPENROUTER_API_KEY, modelGateway);
  if (modelGateway !== "openrouter" || openRouterApiKey === null) {
    throw new ConfigurationError(
      "MODEL_GATEWAY",
      "The initialization job requires the hosted OpenRouter gateway",
    );
  }
  return Object.freeze({
    applicationDatabaseUrl,
    applicationEnvironment: environment.applicationEnvironment,
    deploymentRevision: readDeploymentRevision(source, environment.applicationEnvironment),
    initializationDocument,
    initializationSchemaVersion: 1,
    migrationDatabaseUrl,
    modelGateway,
    nodeEnv: environment.nodeEnv as "production",
    openRouterApiKey,
  });
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Readonly<ApiConfig> {
  const environment = readNormalEnvironment(source);
  const applicationEnvironment = environment.applicationEnvironment;
  if (hosted(applicationEnvironment)) {
    rejectConfiguredKeys(
      source,
      [
        "CAPSTONE_BOOTSTRAP_DATABASE_URL",
        "CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL",
        "CAPSTONE_INITIALIZATION_DOCUMENT",
        "CAPSTONE_INITIALIZATION_SCHEMA_VERSION",
      ],
      "The application service cannot receive initialization credentials",
    );
  }
  const modelGateway = readModelGateway(source.MODEL_GATEWAY, applicationEnvironment);
  const emailDelivery = readEmailDelivery(source.EMAIL_DELIVERY, applicationEnvironment);
  const resend = readResendConfig(source, emailDelivery, applicationEnvironment);
  const otlp = readOtlpConfig(source, applicationEnvironment);
  return Object.freeze({
    applicationEnvironment,
    authSecret: readAuthSecret(source, applicationEnvironment),
    clientAddressSource: hosted(applicationEnvironment) ? "digitalocean-app-platform" : "socket",
    ...readDatabaseConfig(source, applicationEnvironment),
    deploymentRevision: readDeploymentRevision(source, applicationEnvironment),
    emailDelivery,
    emailFrom: resend.emailFrom,
    host: readHost(source.HOST, applicationEnvironment),
    logLevel: readLogLevel(source.LOG_LEVEL, environment.nodeEnv),
    modelGateway,
    nodeEnv: environment.nodeEnv,
    openRouterApiKey: readOpenRouterApiKey(source.OPENROUTER_API_KEY, modelGateway),
    otlpEndpoint: otlp.endpoint,
    otlpHeaders: otlp.headers,
    port: readPort(source.PORT, applicationEnvironment),
    publicOrigin: readPublicOrigin(
      readRequired(
        source,
        "PUBLIC_ORIGIN",
        applicationEnvironment === "development" ? developmentDefaults.publicOrigin : undefined,
      ),
      applicationEnvironment,
    ),
    resendApiKey: resend.resendApiKey,
    stagingEmailRecipients: readStagingEmailRecipients(
      source.CAPSTONE_STAGING_EMAIL_RECIPIENTS,
      applicationEnvironment,
    ),
    trustProxy: false,
    webAssetsDirectory: hosted(applicationEnvironment) ? productionWebAssetsDirectory : null,
  });
}

export function publicConfigMetadata(config: ApiConfig): Readonly<Record<string, unknown>> {
  return Object.freeze({
    applicationEnvironment: config.applicationEnvironment,
    clientAddressSource: config.clientAddressSource,
    deploymentRevision: config.deploymentRevision,
    emailDelivery: config.emailDelivery,
    host: config.host,
    logLevel: config.logLevel,
    modelGateway: config.modelGateway,
    nodeEnv: config.nodeEnv,
    port: config.port,
    publicOrigin: config.publicOrigin,
    telemetry: config.otlpEndpoint !== null,
    trustProxy: config.trustProxy,
    webAssets: config.webAssetsDirectory !== null,
  });
}
