import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasLoadedSecretEnvironment,
  loadSecretEnvironment,
  readSecretEnvironmentFile,
  SecretEnvironmentError,
} from "../src/secret-environment.js";

const temporaryDirectories: string[] = [];
const expectedOwnerUserId = process.getuid?.() ?? 0;

function secretFile(contents: string, mode = 0o440): string {
  const directory = mkdtempSync(join(tmpdir(), "capstone-secret-environment-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "runtime.json");
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, mode);
  return path;
}

function load(source: NodeJS.ProcessEnv): void {
  loadSecretEnvironment(source, { expectedOwnerUserId });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("production secret environment", () => {
  it("does nothing when no secret file is configured", () => {
    const source: NodeJS.ProcessEnv = { NODE_ENV: "test" };

    load(source);

    expect(source).toEqual({ NODE_ENV: "test" });
    expect(hasLoadedSecretEnvironment(source)).toBe(false);
  });

  it("loads only the approved keys from a strict regular file", () => {
    const path = secretFile(
      JSON.stringify({
        BETTER_AUTH_SECRET: "auth-secret-never-log",
        DATABASE_URL: "postgresql://app:secret@database.example/capstone",
        OPENROUTER_API_KEY: "provider-secret-never-log",
        OTEL_EXPORTER_OTLP_HEADERS: "api-key=telemetry-secret-never-log",
        RESEND_API_KEY: "email-secret-never-log",
      }),
    );
    const source: NodeJS.ProcessEnv = { CAPSTONE_SECRET_FILE: path };

    load(source);

    expect(source).toMatchObject({
      BETTER_AUTH_SECRET: "auth-secret-never-log",
      DATABASE_URL: "postgresql://app:secret@database.example/capstone",
      OPENROUTER_API_KEY: "provider-secret-never-log",
      OTEL_EXPORTER_OTLP_HEADERS: "api-key=telemetry-secret-never-log",
      RESEND_API_KEY: "email-secret-never-log",
    });
    expect(readFileSync(path, "utf8")).toContain("auth-secret-never-log");
    expect(hasLoadedSecretEnvironment(source)).toBe(true);
    source.DATABASE_URL = "postgresql://overridden@database.example/capstone";
    expect(hasLoadedSecretEnvironment(source)).toBe(false);
  });

  it("reads a second strict secret file without mutating the environment", () => {
    const path = secretFile(
      JSON.stringify({
        BETTER_AUTH_SECRET: "separate-runtime-auth-secret",
        DATABASE_URL: "postgresql://app:secret@database.example/capstone",
      }),
    );
    const source: NodeJS.ProcessEnv = { NODE_ENV: "production" };

    const secrets = readSecretEnvironmentFile(path, { expectedOwnerUserId });

    expect(secrets).toEqual({
      BETTER_AUTH_SECRET: "separate-runtime-auth-secret",
      DATABASE_URL: "postgresql://app:secret@database.example/capstone",
    });
    expect(Object.isFrozen(secrets)).toBe(true);
    expect(source).toEqual({ NODE_ENV: "production" });
  });

  it.each([
    ["relative path", () => "runtime.json"],
    ["wrong mode", () => secretFile('{"DATABASE_URL":"postgresql://database/capstone"}', 0o640)],
    ["malformed JSON", () => secretFile("{not-json")],
    ["empty object", () => secretFile("{}")],
    ["unknown key", () => secretFile('{"PUBLIC_ORIGIN":"https://private.example"}')],
    ["empty value", () => secretFile('{"DATABASE_URL":"  "}')],
    ["oversized file", () => secretFile(`{"DATABASE_URL":"${"x".repeat(32 * 1_024)}"}`)],
  ])("rejects a %s without exposing file contents", (_label, createPath) => {
    const path = createPath();
    const source: NodeJS.ProcessEnv = { CAPSTONE_SECRET_FILE: path };

    expect(() => load(source)).toThrow(SecretEnvironmentError);
    try {
      load(source);
    } catch (error: unknown) {
      expect(String(error)).not.toContain("postgresql://database/capstone");
      expect(String(error)).not.toContain("private.example");
    }
  });

  it("rejects symlinks", () => {
    const target = secretFile('{"DATABASE_URL":"postgresql://database/capstone"}');
    const link = join(target, "..", "runtime-link.json");
    symlinkSync(target, link);

    expect(() => load({ CAPSTONE_SECRET_FILE: link })).toThrow(SecretEnvironmentError);
  });

  it("rejects duplicate environment sources without partial mutation", () => {
    const path = secretFile(
      JSON.stringify({
        DATABASE_URL: "postgresql://file-secret@database/capstone",
        OPENROUTER_API_KEY: "file-provider-secret",
      }),
    );
    const source: NodeJS.ProcessEnv = {
      CAPSTONE_SECRET_FILE: path,
      DATABASE_URL: "postgresql://environment-secret@database/capstone",
    };

    expect(() => load(source)).toThrow(SecretEnvironmentError);
    expect(source.DATABASE_URL).toBe("postgresql://environment-secret@database/capstone");
    expect(source.OPENROUTER_API_KEY).toBeUndefined();
  });
});
