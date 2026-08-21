import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadDotenv: vi.fn(),
  loadSecretEnvironment: vi.fn(),
}));

vi.mock("dotenv", () => ({ config: mocks.loadDotenv }));
vi.mock("../src/secret-environment.js", () => ({
  loadSecretEnvironment: mocks.loadSecretEnvironment,
}));

import { loadEnvironmentFile, loadRecoveryEnvironmentFile } from "../src/environment.js";

describe("entrypoint environment loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads only dotenv configuration for normal entrypoints", () => {
    loadEnvironmentFile();

    expect(mocks.loadDotenv).toHaveBeenCalledOnce();
    expect(mocks.loadSecretEnvironment).not.toHaveBeenCalled();
  });

  it("loads the authenticated secret file only for recovery preparation", () => {
    loadRecoveryEnvironmentFile();

    expect(mocks.loadDotenv).toHaveBeenCalledOnce();
    expect(mocks.loadSecretEnvironment).toHaveBeenCalledOnce();
    expect(mocks.loadSecretEnvironment).toHaveBeenCalledWith(process.env);
  });
});
