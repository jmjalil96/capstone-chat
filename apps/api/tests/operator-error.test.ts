import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../src/config.js";
import { operationalErrorMetadata } from "../src/operator-error.js";

describe("operationalErrorMetadata", () => {
  it("identifies configuration fields without logging values or messages", () => {
    const error = new ConfigurationError(
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_SECRET contained a secret value",
    );

    const metadata = operationalErrorMetadata(error);

    expect(metadata).toEqual({
      configurationKey: "BETTER_AUTH_SECRET",
      errorName: "ConfigurationError",
    });
    expect(JSON.stringify(metadata)).not.toContain("contained a secret value");
  });

  it("allows PostgreSQL diagnostics but excludes queries, parameters, messages, and stacks", () => {
    const databaseError = Object.assign(new Error("query included private draft text"), {
      code: "23505",
      constraint: "messages_pkey",
      parameters: ["private draft text"],
      query: "insert private draft text",
    });
    const error = new Error("migration failed around private draft text", { cause: databaseError });

    const metadata = operationalErrorMetadata(error);

    expect(metadata).toEqual({
      databaseConstraint: "messages_pkey",
      errorCode: "23505",
      errorName: "Error",
    });
    expect(JSON.stringify(metadata)).not.toContain("private draft text");
  });
});
