import { describe, expect, it } from "vitest";
import {
  buildOpenRouterCatalogSnapshot,
  CatalogValidationError,
  deriveChargeCeilings,
  verifyPrivacyAttestation,
} from "../src/model-policy/catalog.js";
import {
  applyReservationMarginToUnitPrice,
  calculateReservationUsd,
  canonicalTokenCount,
  canonicalUnitPrice,
  canonicalUsd,
  DecimalInputError,
  unitPricePerMillion,
} from "../src/model-policy/money.js";
import { conservativeTokenEstimate } from "../src/model-policy/settings.js";

describe("exact cost arithmetic", () => {
  it("canonicalizes plain decimals without accepting lossy or ambiguous inputs", () => {
    expect(canonicalUsd("12.340000000000000000")).toBe("12.34");
    expect(canonicalUnitPrice("0.000000100000000000000000")).toBe("0.0000001");
    expect(unitPricePerMillion("0.00000123456789")).toBe("1.23456789");
    expect(canonicalTokenCount("9007199254740993")).toBe(9_007_199_254_740_993n);
    expect(() => canonicalUsd("1e-3")).toThrow(DecimalInputError);
    expect(() => canonicalUsd("01.2")).toThrow(DecimalInputError);
    expect(() => canonicalUsd("0.0000000000000000001")).toThrow(DecimalInputError);
    expect(() => canonicalTokenCount(9_007_199_254_740_992)).toThrow(DecimalInputError);
  });

  it("rounds conservative ceilings upward and includes a fixed zero request price", () => {
    expect(applyReservationMarginToUnitPrice("0.000000000000000001", 1)).toBe(
      "0.0000000000000000010001",
    );
    expect(
      calculateReservationUsd({
        completionPriceCeilingPerToken: "0.000002",
        estimatedInputTokens: 1_001n,
        maximumOutputTokens: 500,
        promptPriceCeilingPerToken: "0.000001",
        requestPriceCeilingUsd: "0",
      }),
    ).toBe("0.002001");
  });
});

describe("catalog charge validation", () => {
  it("bounds cache, reasoning, fixed-request, and conditional pricing independently", () => {
    expect(
      deriveChargeCeilings({
        base: {
          completion: "0.000002",
          input_cache_read: "0.0000005",
          input_cache_write: "0.00000025",
          internal_reasoning: "0.000003",
          prompt: "0.000001",
          request: "0",
        },
        overrides: [
          {
            completion: "0.000004",
            input_cache_read: "0",
            input_cache_write: "0",
            internal_reasoning: "0.000003",
            prompt: "0.000002",
            request: "0.01",
          },
        ],
      }),
    ).toEqual({
      completionPricePerToken: "0.000007",
      promptPricePerToken: "0.000002",
      requestPriceUsd: "0.01",
    });
  });

  it("fails closed on non-zero unknown or unsupported dimensions", () => {
    expect(() =>
      deriveChargeCeilings({
        base: { completion: "1", image: "0.01", prompt: "1", request: "0" },
      }),
    ).toThrow(CatalogValidationError);
    expect(() =>
      deriveChargeCeilings({
        base: { completion: "1", future_surcharge: "0.01", prompt: "1", request: "0" },
      }),
    ).toThrow(CatalogValidationError);
    expect(
      deriveChargeCeilings({
        base: { completion: "1", future_surcharge: "0", prompt: "1", request: "0" },
      }).requestPriceUsd,
    ).toBe("0");
    expect(
      deriveChargeCeilings({
        base: { completion: "1", image: "0", prompt: "1", request: "0" },
      }).requestPriceUsd,
    ).toBe("0");
  });

  it("requires explicit prompt, completion, and fixed-request prices, including zero", () => {
    for (const missing of ["prompt", "completion", "request"] as const) {
      const pricing: Record<string, string> = {
        completion: "0.000002",
        prompt: "0.000001",
        request: "0",
      };
      delete pricing[missing];
      expect(() => deriveChargeCeilings({ base: pricing })).toThrow(
        new RegExp(`Pricing component ${missing} is required`, "u"),
      );
    }
  });

  it("joins exact ZDR endpoints and normalizes reasoning capability", () => {
    const model = {
      canonicalSlug: "approved/model",
      contextLength: 128_000,
      displayName: "Approved",
      inputModalities: ["text"],
      maximumOutputTokens: 8_192,
      modelId: "approved/model",
      outputModalities: ["text"],
      reasoning: {
        supportedEfforts: ["low", "medium", "high"],
        supportsMaxTokens: true,
      },
      supportedParameters: ["max_tokens", "reasoning"],
    } as const;
    const snapshot = buildOpenRouterCatalogSnapshot(
      model,
      [
        {
          contextLength: 100_000,
          healthy: true,
          inputModalities: ["text"],
          maximumOutputTokens: 4_096,
          modelId: "approved/model",
          outputModalities: ["text"],
          pricing: { base: { completion: "0.000002", prompt: "0.000001", request: "0" } },
          supportedParameters: ["max_tokens", "reasoning"],
          zdr: true,
        },
        {
          contextLength: 128_000,
          healthy: true,
          inputModalities: ["text"],
          maximumOutputTokens: 8_192,
          modelId: "another/model",
          outputModalities: ["text"],
          pricing: { base: { completion: "100", prompt: "100" } },
          supportedParameters: ["max_tokens", "reasoning"],
          zdr: true,
        },
      ],
      new Date("2026-08-08T12:00:00.000Z"),
    );
    expect(snapshot).toMatchObject({
      capability: {
        reasoning: {
          effortSupport: { kind: "none" },
          kind: "optional",
          maxTokensAccepted: true,
          traceSafety: "provider_excluded",
        },
        temperatureSupported: false,
      },
      contextLength: 100_000,
      maximumOutputTokens: 4_096,
      modelId: "approved/model",
    });
    const { reasoning: _reasoning, ...nonReasoningModel } = model;
    expect(
      buildOpenRouterCatalogSnapshot(
        { ...nonReasoningModel, supportedParameters: ["max_tokens"] },
        [
          {
            contextLength: 100_000,
            healthy: true,
            inputModalities: ["text"],
            maximumOutputTokens: 4_096,
            modelId: "approved/model",
            outputModalities: ["text"],
            pricing: {
              base: { completion: "0.000002", prompt: "0.000001", request: "0" },
            },
            supportedParameters: ["max_tokens"],
            zdr: true,
          },
        ],
        new Date("2026-08-08T12:00:00.000Z"),
      ),
    ).toMatchObject({
      available: true,
      capability: {
        reasoning: {
          kind: "none",
          traceSafety: "non_reasoning",
        },
      },
    });
  });

  it("ignores a malformed eligible endpoint when another endpoint is fully bounded", () => {
    const commonEndpoint = {
      contextLength: 100_000,
      healthy: true,
      inputModalities: ["text"],
      maximumOutputTokens: 4_096,
      modelId: "approved/model",
      outputModalities: ["text"],
      supportedParameters: ["max_tokens", "reasoning"],
      zdr: true,
    } as const;
    const snapshot = buildOpenRouterCatalogSnapshot(
      {
        canonicalSlug: "approved/model",
        contextLength: 128_000,
        displayName: "Approved",
        inputModalities: ["text"],
        maximumOutputTokens: 8_192,
        modelId: "approved/model",
        outputModalities: ["text"],
        supportedParameters: ["max_tokens", "reasoning"],
      },
      [
        { ...commonEndpoint, pricing: { base: { completion: "0.9", prompt: "0.8" } } },
        {
          ...commonEndpoint,
          pricing: {
            base: { completion: "0.000002", prompt: "0.000001", request: "0" },
          },
        },
      ],
      new Date("2026-08-08T12:00:00.000Z"),
    );
    expect(snapshot).toMatchObject({
      completionPricePerToken: "0.000002",
      promptPricePerToken: "0.000001",
      requestPriceUsd: "0",
    });
  });

  it("records only a versioned privacy attestation after every logging facility is disabled", () => {
    const verifiedAt = new Date("2026-08-08T12:00:00.000Z");
    expect(
      verifyPrivacyAttestation({
        attestationVersion: "openrouter-privacy-v1",
        broadcastEnabled: false,
        dataDiscountLoggingEnabled: false,
        inputOutputLoggingEnabled: false,
        verifiedAt,
      }),
    ).toEqual({ attestationVersion: "openrouter-privacy-v1", verifiedAt });
    for (const enabledSetting of [
      "broadcastEnabled",
      "dataDiscountLoggingEnabled",
      "inputOutputLoggingEnabled",
    ] as const) {
      expect(() =>
        verifyPrivacyAttestation({
          attestationVersion: "openrouter-privacy-v1",
          broadcastEnabled: false,
          dataDiscountLoggingEnabled: false,
          inputOutputLoggingEnabled: false,
          [enabledSetting]: true,
          verifiedAt,
        }),
      ).toThrow(CatalogValidationError);
    }
  });
});

it("uses UTF-8 bytes plus fixed request and per-message framing for a conservative estimate", () => {
  expect(conservativeTokenEstimate(["hola", "🧭"])).toBe(72n);
});
