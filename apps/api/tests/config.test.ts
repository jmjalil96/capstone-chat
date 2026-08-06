import { describe, expect, it } from "vitest";
import { loadConfig, publicConfigMetadata } from "../src/config.js";

const productionEnvironment = {
  DATABASE_URL: "postgresql://app:secret@database.internal:5432/capstone",
  NODE_ENV: "production",
  PUBLIC_ORIGIN: "https://chat.capstone.example",
} satisfies NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("returns frozen development defaults", () => {
    const config = loadConfig({});

    expect(config).toEqual({
      databaseUrl: "postgresql://capstone:capstone@127.0.0.1:5432/capstone_chat",
      host: "127.0.0.1",
      logLevel: "info",
      nodeEnv: "development",
      port: 3000,
      publicOrigin: "http://localhost:5173",
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("accepts explicit test configuration", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://tester:tester@localhost:6543/test_database",
      HOST: "0.0.0.0",
      LOG_LEVEL: "debug",
      NODE_ENV: "test",
      PORT: "4100",
      PUBLIC_ORIGIN: "http://127.0.0.1:5173/",
    });

    expect(config).toMatchObject({
      host: "0.0.0.0",
      logLevel: "debug",
      nodeEnv: "test",
      port: 4100,
      publicOrigin: "http://127.0.0.1:5173",
    });
  });

  it.each([
    [{ NODE_ENV: "production", PUBLIC_ORIGIN: "https://chat.capstone.example" }, "DATABASE_URL"],
    [
      {
        DATABASE_URL: "postgresql://database.internal/capstone",
        NODE_ENV: "production",
      },
      "PUBLIC_ORIGIN",
    ],
    [{ ...productionEnvironment, PUBLIC_ORIGIN: "http://chat.capstone.example" }, "https"],
    [{ ...productionEnvironment, PORT: "0" }, "PORT"],
    [{ ...productionEnvironment, DATABASE_URL: "https://database.internal/capstone" }, "postgres"],
    [{ ...productionEnvironment, LOG_LEVEL: "verbose" }, "LOG_LEVEL"],
  ] satisfies [NodeJS.ProcessEnv, string][])(
    "rejects invalid production configuration %#",
    (environment, message) => {
      expect(() => loadConfig(environment)).toThrow(message);
    },
  );

  it("does not expose the database URL in startup metadata", () => {
    const metadata = publicConfigMetadata(loadConfig(productionEnvironment));

    expect(metadata).not.toHaveProperty("databaseUrl");
    expect(JSON.stringify(metadata)).not.toContain("secret");
    expect(Object.isFrozen(metadata)).toBe(true);
  });
});
