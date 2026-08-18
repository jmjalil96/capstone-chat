import { fileURLToPath } from "node:url";
import {
  assertProductionDatabaseCredentialBoundary,
  parseProductionDatabaseUrl,
} from "./database/production-database-url.js";
import { hasLoadedSecretEnvironment } from "./secret-environment.js";

const runtimeModes = ["development", "test", "production"] as const;
const logLevels = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

export type RuntimeMode = (typeof runtimeModes)[number];
export type LogLevel = (typeof logLevels)[number];
export type EmailDelivery = "disabled" | "fake" | "resend";
export type ModelGatewayMode = "fake" | "openrouter";
export type ClientAddressSource = "digitalocean-app-platform" | "socket";
export type DeploymentTarget = "digitalocean-app-platform";
export type DeploymentProfile = "managed-rehearsal";
export type SecretSource = "platform-environment";

const configurationKeys = [
  "BETTER_AUTH_SECRET",
  "CAPSTONE_BOOTSTRAP_DATABASE_URL",
  "CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL",
  "CAPSTONE_DEPLOYMENT_PROFILE",
  "CAPSTONE_INITIALIZATION_DOCUMENT",
  "CAPSTONE_INITIALIZATION_SCHEMA_VERSION",
  "CAPSTONE_LOAD_DIAGNOSTICS_SECRET",
  "CAPSTONE_SECRET_FILE",
  "CAPSTONE_SECRET_SOURCE",
  "CLIENT_ADDRESS_SOURCE",
  "DATABASE_URL",
  "DEPLOYMENT_TARGET",
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
  "WEB_ASSETS",
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

export interface EgressBootstrapConfig {
  readonly clientAddressSource: "digitalocean-app-platform";
  readonly deploymentRevision: string;
  readonly deploymentTarget: DeploymentTarget;
  readonly host: "0.0.0.0";
  readonly nodeEnv: "production";
  readonly port: 3000;
  readonly secretSource: SecretSource;
}

export interface ManagedRehearsalInitializationConfig {
  readonly applicationDatabaseUrl: string;
  readonly deploymentProfile: "managed-rehearsal";
  readonly deploymentRevision: string;
  readonly deploymentTarget: DeploymentTarget;
  readonly initializationDocument: string;
  readonly initializationSchemaVersion: 2;
  readonly migrationDatabaseUrl: string;
  readonly nodeEnv: "test";
  readonly secretSource: SecretSource;
}

export interface InitializationOperatorConfig {
  readonly applicationDatabaseUrl: string;
  readonly deploymentRevision: string;
  readonly deploymentTarget: DeploymentTarget;
  readonly initializationDocument: string;
  readonly initializationSchemaVersion: 2;
  readonly migrationDatabaseUrl: string;
  readonly modelGateway: "openrouter";
  readonly nodeEnv: "production";
  readonly openRouterApiKey: string;
  readonly secretSource: SecretSource;
}

export interface ApiConfig {
  readonly authSecret: string;
  readonly clientAddressSource: ClientAddressSource;
  readonly databaseUrl: string;
  readonly deploymentProfile: DeploymentProfile | null;
  readonly deploymentRevision: string;
  readonly deploymentTarget: DeploymentTarget | null;
  readonly emailDelivery: EmailDelivery;
  readonly emailFrom: string | null;
  readonly host: string;
  readonly logLevel: LogLevel;
  readonly loadDiagnosticsSecret: string | null;
  readonly modelGateway: ModelGatewayMode;
  readonly nodeEnv: RuntimeMode;
  readonly openRouterApiKey: string | null;
  readonly otlpEndpoint: string | null;
  readonly otlpHeaders: Readonly<Record<string, string>>;
  readonly port: number;
  readonly publicOrigin: string;
  readonly resendApiKey: string | null;
  readonly secretSource: SecretSource | null;
  readonly trustProxy: false;
  readonly webAssetsDirectory: string | null;
}

const productionOrigin = "https://chat.capstone.com.ec";
export const managedRehearsalOrigin = "https://rehearsal.chat.capstone.com.ec";
const productionSender = "Capstone Chat <no-reply@mail.capstone.com.ec>";
const productionWebAssetsDirectory = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const productionWebAssetsMode = "production-build";
const appPlatformDeploymentTarget = "digitalocean-app-platform";
const managedRehearsalDeploymentProfile = "managed-rehearsal";
const platformEnvironmentSecretSource = "platform-environment";
const initializationDocumentMaximumBytes = 32 * 1_024;

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

function requireOfflineRecoverySecretFile(source: NodeJS.ProcessEnv, mode: RuntimeMode): void {
  if (mode === "production" && source === process.env && !hasLoadedSecretEnvironment(source)) {
    throw new ConfigurationError(
      "CAPSTONE_SECRET_FILE",
      "CAPSTONE_SECRET_FILE must be the authenticated offline recovery credential source",
    );
  }
}

function readDeploymentTarget(
  value: string | undefined,
  mode: RuntimeMode,
  deploymentProfile: DeploymentProfile | null = null,
): DeploymentTarget | null {
  const target = value?.trim();
  if (target === undefined || target.length === 0) {
    if (mode === "production" || deploymentProfile !== null) {
      throw new ConfigurationError(
        "DEPLOYMENT_TARGET",
        "DEPLOYMENT_TARGET is required in production",
      );
    }
    return null;
  }
  if (target !== appPlatformDeploymentTarget) {
    throw new ConfigurationError(
      "DEPLOYMENT_TARGET",
      `DEPLOYMENT_TARGET must be ${appPlatformDeploymentTarget}`,
    );
  }
  return target;
}

function readSecretSource(
  value: string | undefined,
  mode: RuntimeMode,
  deploymentProfile: DeploymentProfile | null = null,
): SecretSource | null {
  const source = value?.trim();
  if (source === undefined || source.length === 0) {
    if (mode === "production" || deploymentProfile !== null) {
      throw new ConfigurationError(
        "CAPSTONE_SECRET_SOURCE",
        "CAPSTONE_SECRET_SOURCE is required in production",
      );
    }
    return null;
  }
  if (source !== platformEnvironmentSecretSource) {
    throw new ConfigurationError(
      "CAPSTONE_SECRET_SOURCE",
      `CAPSTONE_SECRET_SOURCE must be ${platformEnvironmentSecretSource}`,
    );
  }
  return source;
}

function readDeploymentProfile(
  value: string | undefined,
  mode: RuntimeMode,
): DeploymentProfile | null {
  const profile = value?.trim();
  if (profile === undefined || profile.length === 0) {
    return null;
  }
  if (profile !== managedRehearsalDeploymentProfile) {
    throw new ConfigurationError(
      "CAPSTONE_DEPLOYMENT_PROFILE",
      `CAPSTONE_DEPLOYMENT_PROFILE must be ${managedRehearsalDeploymentProfile}`,
    );
  }
  if (mode !== "test") {
    throw new ConfigurationError(
      "CAPSTONE_DEPLOYMENT_PROFILE",
      "CAPSTONE_DEPLOYMENT_PROFILE=managed-rehearsal is permitted only in test mode",
    );
  }
  return profile;
}

function readProductionPlatformAuthority(
  source: NodeJS.ProcessEnv,
  mode: RuntimeMode,
  deploymentProfile: DeploymentProfile | null = null,
): Readonly<{
  deploymentTarget: DeploymentTarget | null;
  secretSource: SecretSource | null;
}> {
  const deploymentTarget = readDeploymentTarget(source.DEPLOYMENT_TARGET, mode, deploymentProfile);
  const secretSource = readSecretSource(source.CAPSTONE_SECRET_SOURCE, mode, deploymentProfile);
  if (
    (mode === "production" || deploymentProfile !== null) &&
    source.CAPSTONE_SECRET_FILE !== undefined
  ) {
    throw new ConfigurationError(
      "CAPSTONE_SECRET_FILE",
      "CAPSTONE_SECRET_FILE is prohibited for the production application and migration job",
    );
  }
  return Object.freeze({ deploymentTarget, secretSource });
}

function readRequired(
  source: NodeJS.ProcessEnv,
  key:
    | "BETTER_AUTH_SECRET"
    | "CAPSTONE_BOOTSTRAP_DATABASE_URL"
    | "CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL"
    | "DATABASE_URL"
    | "PUBLIC_ORIGIN",
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
  if (mode === "production" && host !== "0.0.0.0") {
    throw new ConfigurationError("HOST", "HOST must be 0.0.0.0 in production");
  }

  return host;
}

function readClientAddressSource(
  value: string | undefined,
  mode: RuntimeMode,
): ClientAddressSource {
  const source = value?.trim() || (mode === "production" ? undefined : "socket");
  if (source !== "digitalocean-app-platform" && source !== "socket") {
    throw new ConfigurationError(
      "CLIENT_ADDRESS_SOURCE",
      "CLIENT_ADDRESS_SOURCE must be digitalocean-app-platform or socket",
    );
  }
  if (mode === "production" && source !== "digitalocean-app-platform") {
    throw new ConfigurationError(
      "CLIENT_ADDRESS_SOURCE",
      "CLIENT_ADDRESS_SOURCE must be digitalocean-app-platform in production",
    );
  }
  return source;
}

function readPort(value: string | undefined, mode: RuntimeMode): number {
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
  if (mode === "production" && port !== 3_000) {
    throw new ConfigurationError("PORT", "PORT must be 3000 in production");
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
        "DATABASE_URL must use credentials, a DNS host, direct port 5432, and exactly one verify-full platform-trusted TLS setting in production or the managed rehearsal",
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
  if (
    endpoint.origin !== "https://otlp.nr-data.net" &&
    endpoint.origin !== "https://otlp.eu01.nr-data.net"
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

function readWebAssetsDirectory(value: string | undefined, mode: RuntimeMode): string | null {
  if (mode === "production") {
    if (value !== undefined && value.trim() !== productionWebAssetsMode) {
      throw new ConfigurationError(
        "WEB_ASSETS",
        `WEB_ASSETS must be ${productionWebAssetsMode} when configured`,
      );
    }
    return productionWebAssetsDirectory;
  }

  if (value === undefined) {
    return null;
  }
  if (mode !== "test" || value.trim() !== productionWebAssetsMode) {
    throw new ConfigurationError(
      "WEB_ASSETS",
      `WEB_ASSETS=${productionWebAssetsMode} is permitted only for the managed test rehearsal`,
    );
  }
  return productionWebAssetsDirectory;
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
  deploymentProfile: DeploymentProfile | null = null,
): Readonly<DatabaseConfig> {
  const databaseMode =
    deploymentProfile !== null ||
    (nodeEnv === "test" && source.WEB_ASSETS?.trim() === productionWebAssetsMode)
      ? "production"
      : nodeEnv;
  const allowDevelopmentDefaults = databaseMode !== "production";
  const databaseUrl = readDatabaseUrl(
    readRequired(
      source,
      "DATABASE_URL",
      allowDevelopmentDefaults ? developmentDefaults.databaseUrl : undefined,
    ),
    databaseMode,
  );

  return Object.freeze({ databaseUrl });
}

export function loadDatabaseConfig(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<DatabaseConfig> {
  const nodeEnv = readRuntimeMode(source.NODE_ENV);
  const deploymentProfile = readDeploymentProfile(source.CAPSTONE_DEPLOYMENT_PROFILE, nodeEnv);
  readProductionPlatformAuthority(source, nodeEnv, deploymentProfile);
  if (nodeEnv === "production" || deploymentProfile !== null) {
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
      "The migration job cannot receive application or initialization credentials",
    );
  }
  return readDatabaseConfig(source, nodeEnv, deploymentProfile);
}

export function loadOpenRouterOperatorConfig(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<OpenRouterOperatorConfig> {
  const nodeEnv = readRuntimeMode(source.NODE_ENV);
  const deploymentProfile = readDeploymentProfile(source.CAPSTONE_DEPLOYMENT_PROFILE, nodeEnv);
  readProductionPlatformAuthority(source, nodeEnv, deploymentProfile);
  if (deploymentProfile !== null) {
    throw new ConfigurationError(
      "OPENROUTER_API_KEY",
      "OpenRouter operator access is prohibited in the managed rehearsal",
    );
  }
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
  readProductionPlatformAuthority(source, nodeEnv);
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
  requireOfflineRecoverySecretFile(source, nodeEnv);
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

function requireProductionMode(source: NodeJS.ProcessEnv): "production" {
  const nodeEnv = readRuntimeMode(source.NODE_ENV);
  if (nodeEnv !== "production") {
    throw new ConfigurationError("NODE_ENV", "NODE_ENV must be production for this entrypoint");
  }
  return nodeEnv;
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

function readManagedRehearsalRevision(source: NodeJS.ProcessEnv): string {
  const revision = source.DEPLOYMENT_REVISION?.trim();
  if (revision === undefined || !/^[0-9a-f]{40}$/iu.test(revision)) {
    throw new ConfigurationError(
      "DEPLOYMENT_REVISION",
      "DEPLOYMENT_REVISION must be a full Git commit identifier for the managed rehearsal",
    );
  }
  return revision.toLowerCase();
}

function readLoadDiagnosticsSecret(value: string | undefined, required: boolean): string | null {
  if (value === undefined) {
    if (required) {
      throw new ConfigurationError(
        "CAPSTONE_LOAD_DIAGNOSTICS_SECRET",
        "CAPSTONE_LOAD_DIAGNOSTICS_SECRET is required for the managed rehearsal",
      );
    }
    return null;
  }
  if (
    value.trim() !== value ||
    containsControlCharacter(value) ||
    Buffer.byteLength(value, "utf8") < 32 ||
    Buffer.byteLength(value, "utf8") > 256
  ) {
    throw new ConfigurationError(
      "CAPSTONE_LOAD_DIAGNOSTICS_SECRET",
      "CAPSTONE_LOAD_DIAGNOSTICS_SECRET must contain 32 to 256 UTF-8 bytes without whitespace padding or control characters",
    );
  }
  return value;
}

const migrationConfigurationKeys = new Set<ConfigurationKey>([
  "CAPSTONE_DEPLOYMENT_PROFILE",
  "CAPSTONE_SECRET_SOURCE",
  "DATABASE_URL",
  "DEPLOYMENT_REVISION",
  "DEPLOYMENT_TARGET",
  "NODE_ENV",
]);

export function loadMigrationConfig(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<DatabaseConfig> {
  const nodeEnv = readRuntimeMode(source.NODE_ENV);
  const deploymentProfile = readDeploymentProfile(source.CAPSTONE_DEPLOYMENT_PROFILE, nodeEnv);
  readProductionPlatformAuthority(source, nodeEnv, deploymentProfile);
  if (nodeEnv === "production" || deploymentProfile !== null) {
    rejectConfigurationOutside(
      source,
      migrationConfigurationKeys,
      "The migration job cannot receive application, provider, telemetry, or initialization configuration",
    );
  }
  if (deploymentProfile !== null) {
    readManagedRehearsalRevision(source);
  }
  return readDatabaseConfig(source, nodeEnv, deploymentProfile);
}

export function loadEgressBootstrapConfig(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<EgressBootstrapConfig> {
  const nodeEnv = requireProductionMode(source);
  rejectConfigurationOutside(
    source,
    new Set<ConfigurationKey>([
      "CAPSTONE_SECRET_SOURCE",
      "CLIENT_ADDRESS_SOURCE",
      "DEPLOYMENT_REVISION",
      "DEPLOYMENT_TARGET",
      "HOST",
      "NODE_ENV",
      "PORT",
    ]),
    "The egress bootstrap cannot receive runtime secrets or unrelated configuration",
  );
  rejectConfiguredKeys(
    source,
    ["CAPSTONE_SECRET_FILE"],
    "The egress bootstrap cannot receive a secret file",
  );
  const deploymentTarget = readDeploymentTarget(source.DEPLOYMENT_TARGET, nodeEnv);
  if (deploymentTarget === null) {
    throw new ConfigurationError("DEPLOYMENT_TARGET", "DEPLOYMENT_TARGET is required");
  }
  const secretSource = readSecretSource(source.CAPSTONE_SECRET_SOURCE, nodeEnv);
  const clientAddressSource = readClientAddressSource(source.CLIENT_ADDRESS_SOURCE, nodeEnv);
  const host = readHost(source.HOST, nodeEnv);
  const port = readPort(source.PORT, nodeEnv);
  if (
    secretSource === null ||
    clientAddressSource !== "digitalocean-app-platform" ||
    host !== "0.0.0.0" ||
    port !== 3_000
  ) {
    throw new ConfigurationError(
      "DEPLOYMENT_TARGET",
      "The egress bootstrap requires the App Platform production authority",
    );
  }

  return Object.freeze({
    clientAddressSource,
    deploymentRevision: readDeploymentRevision(source, nodeEnv),
    deploymentTarget,
    host,
    nodeEnv,
    port,
    secretSource,
  });
}

export function loadInitializationOperatorConfig(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<InitializationOperatorConfig> {
  const nodeEnv = requireProductionMode(source);
  const platform = readProductionPlatformAuthority(source, nodeEnv);
  rejectConfigurationOutside(
    source,
    new Set<ConfigurationKey>([
      "CAPSTONE_BOOTSTRAP_DATABASE_URL",
      "CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL",
      "CAPSTONE_INITIALIZATION_DOCUMENT",
      "CAPSTONE_INITIALIZATION_SCHEMA_VERSION",
      "CAPSTONE_SECRET_SOURCE",
      "DEPLOYMENT_REVISION",
      "DEPLOYMENT_TARGET",
      "MODEL_GATEWAY",
      "NODE_ENV",
      "OPENROUTER_API_KEY",
    ]),
    "The initialization job cannot receive steady application credentials or configuration",
  );

  const schemaVersion = source.CAPSTONE_INITIALIZATION_SCHEMA_VERSION?.trim();
  if (schemaVersion !== "2") {
    throw new ConfigurationError(
      "CAPSTONE_INITIALIZATION_SCHEMA_VERSION",
      "CAPSTONE_INITIALIZATION_SCHEMA_VERSION must be 2",
    );
  }
  const initializationDocument = source.CAPSTONE_INITIALIZATION_DOCUMENT;
  if (initializationDocument === undefined || initializationDocument.trim().length === 0) {
    throw new ConfigurationError(
      "CAPSTONE_INITIALIZATION_DOCUMENT",
      "CAPSTONE_INITIALIZATION_DOCUMENT is required",
    );
  }
  if (Buffer.byteLength(initializationDocument, "utf8") > initializationDocumentMaximumBytes) {
    throw new ConfigurationError(
      "CAPSTONE_INITIALIZATION_DOCUMENT",
      "CAPSTONE_INITIALIZATION_DOCUMENT must be at most 32768 UTF-8 bytes",
    );
  }

  const applicationDatabaseUrl = readDatabaseUrl(
    readRequired(source, "CAPSTONE_BOOTSTRAP_DATABASE_URL", undefined),
    nodeEnv,
  );
  const migrationDatabaseUrl = readDatabaseUrl(
    readRequired(source, "CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL", undefined),
    nodeEnv,
  );
  assertProductionDatabaseCredentialBoundary(migrationDatabaseUrl, applicationDatabaseUrl);

  const modelGateway = readModelGateway(source.MODEL_GATEWAY, nodeEnv);
  if (modelGateway !== "openrouter") {
    throw new ConfigurationError("MODEL_GATEWAY", "MODEL_GATEWAY must be openrouter");
  }
  const openRouterApiKey = readOpenRouterApiKey(source.OPENROUTER_API_KEY, modelGateway);
  if (
    openRouterApiKey === null ||
    platform.deploymentTarget === null ||
    platform.secretSource === null
  ) {
    throw new ConfigurationError(
      "DEPLOYMENT_TARGET",
      "The initialization job requires the App Platform production authority",
    );
  }

  return Object.freeze({
    applicationDatabaseUrl,
    deploymentRevision: readDeploymentRevision(source, nodeEnv),
    deploymentTarget: platform.deploymentTarget,
    initializationDocument,
    initializationSchemaVersion: 2,
    migrationDatabaseUrl,
    modelGateway,
    nodeEnv,
    openRouterApiKey,
    secretSource: platform.secretSource,
  });
}

const managedInitializationConfigurationKeys = new Set<ConfigurationKey>([
  "CAPSTONE_BOOTSTRAP_DATABASE_URL",
  "CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL",
  "CAPSTONE_DEPLOYMENT_PROFILE",
  "CAPSTONE_INITIALIZATION_DOCUMENT",
  "CAPSTONE_INITIALIZATION_SCHEMA_VERSION",
  "CAPSTONE_SECRET_SOURCE",
  "DEPLOYMENT_REVISION",
  "DEPLOYMENT_TARGET",
  "NODE_ENV",
]);

export function loadManagedRehearsalInitializationConfig(
  source: NodeJS.ProcessEnv = process.env,
): Readonly<ManagedRehearsalInitializationConfig> {
  const nodeEnv = readRuntimeMode(source.NODE_ENV);
  const deploymentProfile = readDeploymentProfile(source.CAPSTONE_DEPLOYMENT_PROFILE, nodeEnv);
  if (deploymentProfile === null) {
    throw new ConfigurationError(
      "CAPSTONE_DEPLOYMENT_PROFILE",
      "CAPSTONE_DEPLOYMENT_PROFILE=managed-rehearsal is required",
    );
  }
  if (nodeEnv !== "test") {
    throw new ConfigurationError("NODE_ENV", "NODE_ENV must be test for the managed rehearsal");
  }
  const platform = readProductionPlatformAuthority(source, nodeEnv, deploymentProfile);
  rejectConfigurationOutside(
    source,
    managedInitializationConfigurationKeys,
    "The managed rehearsal initialization job cannot receive steady service, provider, telemetry, or delivery configuration",
  );

  const schemaVersion = source.CAPSTONE_INITIALIZATION_SCHEMA_VERSION?.trim();
  if (schemaVersion !== "2") {
    throw new ConfigurationError(
      "CAPSTONE_INITIALIZATION_SCHEMA_VERSION",
      "CAPSTONE_INITIALIZATION_SCHEMA_VERSION must be 2",
    );
  }
  const initializationDocument = source.CAPSTONE_INITIALIZATION_DOCUMENT;
  if (initializationDocument === undefined || initializationDocument.trim().length === 0) {
    throw new ConfigurationError(
      "CAPSTONE_INITIALIZATION_DOCUMENT",
      "CAPSTONE_INITIALIZATION_DOCUMENT is required",
    );
  }
  if (Buffer.byteLength(initializationDocument, "utf8") > initializationDocumentMaximumBytes) {
    throw new ConfigurationError(
      "CAPSTONE_INITIALIZATION_DOCUMENT",
      "CAPSTONE_INITIALIZATION_DOCUMENT must be at most 32768 UTF-8 bytes",
    );
  }

  const applicationDatabaseUrl = readDatabaseUrl(
    readRequired(source, "CAPSTONE_BOOTSTRAP_DATABASE_URL", undefined),
    "production",
  );
  const migrationDatabaseUrl = readDatabaseUrl(
    readRequired(source, "CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL", undefined),
    "production",
  );
  assertProductionDatabaseCredentialBoundary(migrationDatabaseUrl, applicationDatabaseUrl);
  if (platform.deploymentTarget === null || platform.secretSource === null) {
    throw new ConfigurationError(
      "DEPLOYMENT_TARGET",
      "The managed rehearsal initialization job requires App Platform authority",
    );
  }

  return Object.freeze({
    applicationDatabaseUrl,
    deploymentProfile,
    deploymentRevision: readManagedRehearsalRevision(source),
    deploymentTarget: platform.deploymentTarget,
    initializationDocument,
    initializationSchemaVersion: 2,
    migrationDatabaseUrl,
    nodeEnv,
    secretSource: platform.secretSource,
  });
}

const managedServiceConfigurationKeys = new Set<ConfigurationKey>([
  "BETTER_AUTH_SECRET",
  "CAPSTONE_DEPLOYMENT_PROFILE",
  "CAPSTONE_LOAD_DIAGNOSTICS_SECRET",
  "CAPSTONE_SECRET_SOURCE",
  "CLIENT_ADDRESS_SOURCE",
  "DATABASE_URL",
  "DEPLOYMENT_REVISION",
  "DEPLOYMENT_TARGET",
  "EMAIL_DELIVERY",
  "HOST",
  "LOG_LEVEL",
  "MODEL_GATEWAY",
  "NODE_ENV",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "PORT",
  "PUBLIC_ORIGIN",
  "WEB_ASSETS",
]);

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Readonly<ApiConfig> {
  const nodeEnv = readRuntimeMode(source.NODE_ENV);
  const deploymentProfile = readDeploymentProfile(source.CAPSTONE_DEPLOYMENT_PROFILE, nodeEnv);
  const platform = readProductionPlatformAuthority(source, nodeEnv, deploymentProfile);
  if (deploymentProfile !== null) {
    rejectConfigurationOutside(
      source,
      managedServiceConfigurationKeys,
      "The managed rehearsal service cannot receive initialization, provider, or delivery credentials",
    );
  } else if (nodeEnv === "production") {
    rejectConfiguredKeys(
      source,
      [
        "CAPSTONE_BOOTSTRAP_DATABASE_URL",
        "CAPSTONE_BOOTSTRAP_MIGRATION_DATABASE_URL",
        "CAPSTONE_INITIALIZATION_DOCUMENT",
        "CAPSTONE_INITIALIZATION_SCHEMA_VERSION",
        "CAPSTONE_LOAD_DIAGNOSTICS_SECRET",
      ],
      "The application service cannot receive initialization credentials",
    );
  }
  const { databaseUrl } = readDatabaseConfig(source, nodeEnv, deploymentProfile);
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
  const authSecret = readAuthSecret(source, nodeEnv);
  const clientAddressSource = readClientAddressSource(source.CLIENT_ADDRESS_SOURCE, nodeEnv);
  const host = readHost(source.HOST, nodeEnv);
  const logLevel = readLogLevel(source.LOG_LEVEL, nodeEnv);
  const port = readPort(source.PORT, nodeEnv);
  const webAssetsDirectory = readWebAssetsDirectory(source.WEB_ASSETS, nodeEnv);
  const loadDiagnosticsSecret = readLoadDiagnosticsSecret(
    source.CAPSTONE_LOAD_DIAGNOSTICS_SECRET,
    deploymentProfile !== null,
  );
  let deploymentRevision = readDeploymentRevision(source, nodeEnv);
  let openRouterApiKey: string | null;

  if (deploymentProfile !== null) {
    if (source.BETTER_AUTH_SECRET === undefined) {
      throw new ConfigurationError(
        "BETTER_AUTH_SECRET",
        "BETTER_AUTH_SECRET is required for the managed rehearsal",
      );
    }
    if (publicOrigin !== managedRehearsalOrigin) {
      throw new ConfigurationError(
        "PUBLIC_ORIGIN",
        `PUBLIC_ORIGIN must be ${managedRehearsalOrigin} for the managed rehearsal`,
      );
    }
    if (source.WEB_ASSETS?.trim() !== productionWebAssetsMode || webAssetsDirectory === null) {
      throw new ConfigurationError(
        "WEB_ASSETS",
        `WEB_ASSETS must be ${productionWebAssetsMode} for the managed rehearsal`,
      );
    }
    if (clientAddressSource !== "digitalocean-app-platform") {
      throw new ConfigurationError(
        "CLIENT_ADDRESS_SOURCE",
        "CLIENT_ADDRESS_SOURCE must be digitalocean-app-platform for the managed rehearsal",
      );
    }
    if (host !== "0.0.0.0") {
      throw new ConfigurationError("HOST", "HOST must be 0.0.0.0 for the managed rehearsal");
    }
    if (port !== 3_000) {
      throw new ConfigurationError("PORT", "PORT must be 3000 for the managed rehearsal");
    }
    if (emailDelivery !== "disabled" || source.EMAIL_DELIVERY?.trim() !== "disabled") {
      throw new ConfigurationError(
        "EMAIL_DELIVERY",
        "EMAIL_DELIVERY must be disabled for the managed rehearsal",
      );
    }
    if (modelGateway !== "openrouter" || source.MODEL_GATEWAY?.trim() !== "openrouter") {
      throw new ConfigurationError(
        "MODEL_GATEWAY",
        "MODEL_GATEWAY must be openrouter for managed rehearsal accounting semantics",
      );
    }
    if (logLevel !== "info" || source.LOG_LEVEL?.trim() !== "info") {
      throw new ConfigurationError("LOG_LEVEL", "LOG_LEVEL must be info for the managed rehearsal");
    }
    if (otlp.endpoint === null) {
      throw new ConfigurationError(
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_EXPORTER_OTLP_ENDPOINT is required for the managed rehearsal",
      );
    }
    deploymentRevision = readManagedRehearsalRevision(source);
    openRouterApiKey = null;
  } else {
    openRouterApiKey = readOpenRouterApiKey(source.OPENROUTER_API_KEY, modelGateway);
  }

  return Object.freeze({
    authSecret,
    clientAddressSource,
    databaseUrl,
    deploymentProfile,
    deploymentRevision,
    deploymentTarget: platform.deploymentTarget,
    emailDelivery,
    emailFrom: resend.emailFrom,
    host,
    logLevel,
    loadDiagnosticsSecret,
    modelGateway,
    nodeEnv,
    openRouterApiKey,
    otlpEndpoint: otlp.endpoint,
    otlpHeaders: otlp.headers,
    port,
    publicOrigin,
    resendApiKey: resend.resendApiKey,
    secretSource: platform.secretSource,
    trustProxy: false,
    webAssetsDirectory,
  });
}

export function publicConfigMetadata(config: ApiConfig): Readonly<Record<string, unknown>> {
  return Object.freeze({
    clientAddressSource: config.clientAddressSource,
    deploymentProfile: config.deploymentProfile,
    deploymentTarget: config.deploymentTarget,
    emailDelivery: config.emailDelivery,
    deploymentRevision: config.deploymentRevision,
    host: config.host,
    logLevel: config.logLevel,
    loadDiagnostics: config.loadDiagnosticsSecret !== null,
    modelGateway: config.modelGateway,
    nodeEnv: config.nodeEnv,
    port: config.port,
    publicOrigin: config.publicOrigin,
    trustProxy: config.trustProxy,
    telemetry: config.otlpEndpoint !== null,
    webAssets: config.webAssetsDirectory !== null,
  });
}
