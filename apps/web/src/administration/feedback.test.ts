import { describe, expect, it } from "vitest";

import { copy } from "../copy";
import { AdministrationApiError } from "./api";
import { administrationErrorMessage } from "./feedback";

// MODEL_VALIDATION_FAILED is raised at four call sites in `routes/admin-models.ts` that
// share one error code but not one cause: 422 when the approval itself was rejected, and
// 503 when the loader is absent, the catalog is unreachable, or the refresh write fails.
// The status is the only signal separating "retrying will not help" from "retry later",
// so these cases are asserted apart rather than through a single shared message.
describe("administrationErrorMessage", () => {
  it("tells the administrator a rejected approval will not succeed on retry", () => {
    const message = administrationErrorMessage(
      new AdministrationApiError(422, "MODEL_VALIDATION_FAILED"),
    );

    expect(message).toBe(copy.administration.models.validationRejected);
  });

  it("keeps the unavailable copy free of a specific cause for every 503 origin", () => {
    const message = administrationErrorMessage(
      new AdministrationApiError(503, "MODEL_VALIDATION_FAILED"),
    );

    expect(message).toBe(copy.administration.models.validationUnavailable);
    // A failed refresh write and an absent loader both surface here, so naming
    // the upstream catalog would be wrong in two of the three 503 paths.
    expect(message).not.toContain("OpenRouter");
  });

  it("distinguishes a stale policy from one that conflicts with current state", () => {
    expect(
      administrationErrorMessage(new AdministrationApiError(409, "MODEL_POLICY_CHANGED")),
    ).toBe(copy.administration.models.stale);
    expect(
      administrationErrorMessage(new AdministrationApiError(409, "MODEL_POLICY_CONFLICT")),
    ).toBe(copy.administration.models.conflict);
  });

  it("explains that a catalog refresh is already running", () => {
    expect(
      administrationErrorMessage(new AdministrationApiError(409, "CATALOG_REFRESH_ACTIVE")),
    ).toBe(copy.administration.models.refreshActive);
  });

  it("falls back to the generic message for an unmapped code", () => {
    expect(administrationErrorMessage(new AdministrationApiError(500, "INTERNAL_ERROR"))).toBe(
      copy.administration.common.genericError,
    );
    expect(administrationErrorMessage(new Error("network down"))).toBe(
      copy.administration.common.genericError,
    );
  });
});
