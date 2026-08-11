import { describe, expect, it } from "vitest";
import {
  assertProductionDatabaseCredentialBoundary,
  RecoveryPreparationError,
  toRecoveryPreparationCommandEvidence,
} from "../src/database/recovery-preparation.js";

const migrationUrl =
  "postgresql://capstone_migration:migration-password@aws-us-east-1.psdb.cloud:5432/capstone?sslmode=verify-full";
const applicationUrl =
  "postgresql://capstone_application:application-password@aws-us-east-1.psdb.cloud:5432/capstone?sslmode=verify-full";

describe("restored database production boundary", () => {
  it("accepts distinct direct verify-full credentials for the same database", () => {
    expect(() =>
      assertProductionDatabaseCredentialBoundary(migrationUrl, applicationUrl),
    ).not.toThrow();
  });

  it.each([
    ["same role", applicationUrl.replace("capstone_application", "capstone_migration")],
    ["encoded same role", applicationUrl.replace("capstone_application", "capstone%5Fmigration")],
    ["same password", applicationUrl.replace("application-password", "migration-password")],
    ["different host", applicationUrl.replace("aws-us-east-1", "aws-us-west-2")],
    ["different database", applicationUrl.replace("/capstone?", "/other?")],
    ["pooler port", applicationUrl.replace(":5432", ":6432")],
    ["weakened TLS", applicationUrl.replace("verify-full", "require")],
    ["duplicate TLS mode", `${applicationUrl}&sslmode=disable`],
    ["local CA path", `${applicationUrl}&sslrootcert=system`],
    ["startup options in URL", `${applicationUrl}&options=-c%20statement_timeout%3D0`],
    ["query host override", `${applicationUrl}&host=override.invalid`],
    ["query port override", `${applicationUrl}&port=6432`],
    ["query role override", `${applicationUrl}&user=capstone_migration`],
    ["numeric host", applicationUrl.replace("aws-us-east-1.psdb.cloud", "203.0.113.10")],
  ])("rejects a %s boundary", (_label, invalidApplicationUrl) => {
    expect(() =>
      assertProductionDatabaseCredentialBoundary(migrationUrl, invalidApplicationUrl),
    ).toThrow(RecoveryPreparationError);
  });

  it("emits only closed compatibility evidence and explicit managed-only gates", () => {
    const evidence = toRecoveryPreparationCommandEvidence({
      applicationRole: {
        administrativeWorkDenied: true,
        dataReadWriteVerified: true,
        ddlDenied: true,
      },
      migrationCount: 7,
      migrationRole: {
        clusterAdministrationDenied: true,
        schemaWorkVerified: true,
      },
      objects: { constraints: 10, functions: 1, indexes: 20, tables: 20 },
      postgresMajor: 18,
      sessionGuardsVerified: true,
      tlsVerified: true,
    });

    expect(evidence).toEqual({
      applicationRole: {
        administrativeWorkDenied: true,
        dataReadWriteVerified: true,
        ddlDenied: true,
      },
      managedVerificationRequired: [
        "backup-cadence-and-retention",
        "database-wide-source-ip-restriction",
        "provider-region-tier-and-storage-ceiling",
        "source-ip-denial-and-established-session-termination",
        "tls-hostname-ca-and-credential-denial",
      ],
      migrationCount: 7,
      migrationRole: {
        clusterAdministrationDenied: true,
        schemaWorkVerified: true,
      },
      objects: { constraints: 10, functions: 1, indexes: 20, tables: 20 },
      outcome: "database-compatible",
      postgresMajor: 18,
      sessionGuardsVerified: true,
      tlsVerified: true,
    });
    expect(JSON.stringify(evidence)).not.toContain("postgresql://");
  });
});
