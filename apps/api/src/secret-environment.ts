import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const secretEnvironmentKeys = [
  "BETTER_AUTH_SECRET",
  "DATABASE_URL",
  "OPENROUTER_API_KEY",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "RESEND_API_KEY",
] as const;
const secretEnvironmentKeySet = new Set<string>(secretEnvironmentKeys);
const maximumSecretFileBytes = 32 * 1_024;
const requiredSecretFileMode = 0o440;
interface LoadedSecretEnvironment {
  readonly configuredPath: string;
  readonly secrets: Readonly<Record<string, string>>;
}
const loadedSecretEnvironments = new WeakMap<object, LoadedSecretEnvironment>();

export class SecretEnvironmentError extends Error {
  constructor() {
    super("CAPSTONE_SECRET_FILE is not a valid production secret file");
    this.name = "SecretEnvironmentError";
  }
}

export interface SecretEnvironmentOptions {
  readonly expectedOwnerUserId?: number;
}

function invalidSecretFile(): never {
  throw new SecretEnvironmentError();
}

function parseSecretDocument(contents: Buffer): Readonly<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch {
    invalidSecretFile();
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    invalidSecretFile();
  }

  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    invalidSecretFile();
  }

  const secrets: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (
      !secretEnvironmentKeySet.has(key) ||
      typeof value !== "string" ||
      value.trim().length === 0
    ) {
      invalidSecretFile();
    }
    secrets[key] = value;
  }
  return secrets;
}

export function readSecretEnvironmentFile(
  configuredPath: string,
  options: SecretEnvironmentOptions = {},
): Readonly<Record<string, string>> {
  const expectedOwnerUserId = options.expectedOwnerUserId ?? 0;
  let descriptor: number | null = null;
  let contents: Buffer | null = null;

  try {
    if (!isAbsolute(configuredPath)) {
      invalidSecretFile();
    }

    const pathStatus = lstatSync(configuredPath);
    if (
      !pathStatus.isFile() ||
      pathStatus.isSymbolicLink() ||
      pathStatus.uid !== expectedOwnerUserId ||
      (pathStatus.mode & 0o777) !== requiredSecretFileMode ||
      pathStatus.size < 2 ||
      pathStatus.size > maximumSecretFileBytes
    ) {
      invalidSecretFile();
    }

    descriptor = openSync(configuredPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const descriptorStatus = fstatSync(descriptor);
    if (
      !descriptorStatus.isFile() ||
      descriptorStatus.dev !== pathStatus.dev ||
      descriptorStatus.ino !== pathStatus.ino ||
      descriptorStatus.uid !== expectedOwnerUserId ||
      (descriptorStatus.mode & 0o777) !== requiredSecretFileMode ||
      descriptorStatus.size !== pathStatus.size
    ) {
      invalidSecretFile();
    }

    contents = readFileSync(descriptor);
    return Object.freeze(parseSecretDocument(contents));
  } catch (error: unknown) {
    if (error instanceof SecretEnvironmentError) {
      throw error;
    }
    throw new SecretEnvironmentError();
  } finally {
    contents?.fill(0);
    if (descriptor !== null) {
      closeSync(descriptor);
    }
  }
}

export function loadSecretEnvironment(
  source: NodeJS.ProcessEnv,
  options: SecretEnvironmentOptions = {},
): void {
  const configuredPath = source.CAPSTONE_SECRET_FILE?.trim();
  if (configuredPath === undefined || configuredPath.length === 0) {
    return;
  }

  const secrets = readSecretEnvironmentFile(configuredPath, options);
  for (const key of Object.keys(secrets)) {
    if (source[key] !== undefined) {
      invalidSecretFile();
    }
  }
  for (const [key, value] of Object.entries(secrets)) {
    source[key] = value;
  }
  loadedSecretEnvironments.set(source, Object.freeze({ configuredPath, secrets }));
}

export function hasLoadedSecretEnvironment(source: NodeJS.ProcessEnv): boolean {
  const loaded = loadedSecretEnvironments.get(source);
  return (
    loaded !== undefined &&
    source.CAPSTONE_SECRET_FILE?.trim() === loaded.configuredPath &&
    Object.entries(loaded.secrets).every(([key, value]) => source[key] === value)
  );
}
