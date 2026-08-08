import type { AdminModelCatalogItem, AdminModelCatalogListResponse } from "@capstone/protocol";
import { and, asc, eq, gt, inArray, or } from "drizzle-orm";
import type { CursorCodec } from "../conversations/cursor.js";
import { cursorString } from "../conversations/cursor.js";
import type { AppDatabase, AppTransaction } from "../database/database.js";
import { workspaces } from "../database/identity-schema.js";
import { modelCatalog, workspaceCatalogApprovals } from "../database/model-policy-schema.js";
import { ApplicationError } from "../errors.js";
import type { CatalogModelSnapshot } from "./catalog.js";
import {
  CatalogRefreshActiveError,
  ModelPolicyConflictError,
  ModelPolicyUnavailableError,
} from "./errors.js";
import { canonicalUnitPrice, canonicalUsd } from "./money.js";
import { costControlTuning } from "./settings.js";

type ModelPolicyMode = "openrouter" | "simulated";

const catalogCursorKind = "admin-model-catalog";
const catalogRefreshCursorKind = "admin-model-catalog-refresh";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface CatalogCursor {
  readonly catalogId: string;
  readonly modelId: string;
}

interface CatalogItemRow {
  readonly available: boolean;
  readonly catalogId: string;
  readonly contextLength: number;
  readonly displayName: string;
  readonly maximumOutputTokens: number;
  readonly modelId: string;
  readonly validatedAt: Date;
}

export interface AdminCatalogRefreshClaim {
  readonly modelIds: readonly string[];
  readonly nextCursor: string | null;
  readonly ownerId: string;
}

export interface CatalogAdministrationOptions {
  readonly cursorCodec?: CursorCodec;
  readonly now: () => Date;
}

function invalidCursor(): never {
  throw new ApplicationError(400, "INVALID_CURSOR", "El cursor de paginación no es válido.");
}

function toCatalogItem(row: CatalogItemRow): AdminModelCatalogItem {
  return Object.freeze({
    available: row.available,
    catalogId: row.catalogId,
    contextLength: row.contextLength,
    displayName: row.displayName,
    maximumOutputTokens: row.maximumOutputTokens,
    modelId: row.modelId,
    validatedAt: row.validatedAt.toISOString(),
  });
}

function catalogSelection() {
  return {
    available: modelCatalog.available,
    catalogId: modelCatalog.id,
    contextLength: modelCatalog.contextLength,
    displayName: modelCatalog.displayName,
    maximumOutputTokens: modelCatalog.maximumOutputTokens,
    modelId: modelCatalog.openRouterModelId,
    validatedAt: modelCatalog.validatedAt,
  } as const;
}

function latestDate(...dates: readonly (Date | null)[]): Date {
  return new Date(
    Math.max(...dates.filter((date): date is Date => date !== null).map((date) => date.getTime())),
  );
}

function assertUuid(value: string, label: string): void {
  if (!uuidPattern.test(value)) {
    throw new ModelPolicyConflictError(`${label} must be a UUID`);
  }
}

function validModelId(value: string): boolean {
  const slash = value.indexOf("/");
  return (
    value.length <= 512 &&
    slash > 0 &&
    slash < value.length - 1 &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return /\s/u.test(character) || code < 32 || code === 127;
    })
  );
}

function assertValidatedSnapshot(
  snapshot: CatalogModelSnapshot,
  mode: ModelPolicyMode,
  checkedAt: Date,
): void {
  if (mode !== "openrouter" || snapshot.metadataSource !== "openrouter") {
    throw new ModelPolicyConflictError("Catalog models can be added only in OpenRouter mode");
  }
  if (
    !snapshot.available ||
    !validModelId(snapshot.modelId) ||
    snapshot.displayName.trim().length === 0 ||
    snapshot.displayName.length > 255 ||
    !Number.isSafeInteger(snapshot.contextLength) ||
    snapshot.contextLength <= 0 ||
    !Number.isSafeInteger(snapshot.maximumOutputTokens) ||
    snapshot.maximumOutputTokens <= 0 ||
    snapshot.maximumOutputTokens > snapshot.contextLength ||
    !snapshot.inputModalities.includes("text") ||
    !snapshot.outputModalities.includes("text") ||
    !snapshot.supportedParameters.includes("max_tokens") ||
    !snapshot.supportedParameters.includes("reasoning") ||
    !Number.isFinite(snapshot.validatedAt.getTime()) ||
    snapshot.validatedAt.getTime() > checkedAt.getTime()
  ) {
    throw new ModelPolicyConflictError("Catalog snapshot is not currently eligible");
  }
  try {
    canonicalUnitPrice(snapshot.promptPricePerToken);
    canonicalUnitPrice(snapshot.completionPricePerToken);
    canonicalUsd(snapshot.requestPriceUsd);
  } catch {
    throw new ModelPolicyConflictError("Catalog snapshot pricing is invalid");
  }
}

export function createCatalogAdministration(
  database: AppDatabase,
  options: CatalogAdministrationOptions,
) {
  function cursorCodec(): CursorCodec {
    if (options.cursorCodec === undefined) {
      throw new ModelPolicyConflictError("Administrative cursor support is not configured");
    }
    return options.cursorCodec;
  }

  function decodeCursor(cursor: string, workspaceId: string, kind: string): CatalogCursor {
    const payload = cursorCodec().decode(cursor, kind);
    if (cursorString(payload, "workspaceId") !== workspaceId) {
      return invalidCursor();
    }
    return {
      catalogId: cursorString(payload, "catalogId"),
      modelId: cursorString(payload, "modelId"),
    };
  }

  function encodeCursor(row: CatalogItemRow, workspaceId: string, kind: string): string {
    return cursorCodec().encode({
      catalogId: row.catalogId,
      kind,
      modelId: row.modelId,
      version: 1,
      workspaceId,
    });
  }

  async function listAdminCatalog(
    workspaceId: string,
    cursor?: string,
  ): Promise<AdminModelCatalogListResponse> {
    const after =
      cursor === undefined ? null : decodeCursor(cursor, workspaceId, catalogCursorKind);
    const rows = await database
      .select(catalogSelection())
      .from(workspaceCatalogApprovals)
      .innerJoin(modelCatalog, eq(modelCatalog.id, workspaceCatalogApprovals.modelCatalogId))
      .where(
        and(
          eq(workspaceCatalogApprovals.workspaceId, workspaceId),
          after === null
            ? undefined
            : or(
                gt(modelCatalog.openRouterModelId, after.modelId),
                and(
                  eq(modelCatalog.openRouterModelId, after.modelId),
                  gt(modelCatalog.id, after.catalogId),
                ),
              ),
        ),
      )
      .orderBy(asc(modelCatalog.openRouterModelId), asc(modelCatalog.id))
      .limit(costControlTuning.catalogAdministrationBatchSize + 1);
    const visible = rows.slice(0, costControlTuning.catalogAdministrationBatchSize);
    const last = visible.at(-1);
    return Object.freeze({
      items: visible.map(toCatalogItem),
      nextCursor:
        rows.length <= costControlTuning.catalogAdministrationBatchSize || last === undefined
          ? null
          : encodeCursor(last, workspaceId, catalogCursorKind),
    });
  }

  async function upsertCatalogSnapshot(
    transaction: AppTransaction,
    snapshot: CatalogModelSnapshot,
    updatedAt: Date,
  ): Promise<string> {
    let rows = await transaction
      .select()
      .from(modelCatalog)
      .where(eq(modelCatalog.openRouterModelId, snapshot.modelId))
      .limit(1)
      .for("update");
    if (rows[0] === undefined) {
      const inserted = await transaction
        .insert(modelCatalog)
        .values({
          available: snapshot.available,
          canonicalSlug: snapshot.canonicalSlug,
          completionPricePerToken: snapshot.completionPricePerToken,
          contextLength: snapshot.contextLength,
          createdAt: updatedAt,
          displayName: snapshot.displayName,
          inputModalities: snapshot.inputModalities,
          maximumOutputTokens: snapshot.maximumOutputTokens,
          metadataSource: snapshot.metadataSource,
          openRouterModelId: snapshot.modelId,
          outputModalities: snapshot.outputModalities,
          promptPricePerToken: snapshot.promptPricePerToken,
          requestPriceUsd: snapshot.requestPriceUsd,
          supportedParameters: snapshot.supportedParameters,
          updatedAt,
          validatedAt: snapshot.validatedAt,
        })
        .onConflictDoNothing({ target: modelCatalog.openRouterModelId })
        .returning({ id: modelCatalog.id });
      if (inserted[0] !== undefined) {
        return inserted[0].id;
      }
      rows = await transaction
        .select()
        .from(modelCatalog)
        .where(eq(modelCatalog.openRouterModelId, snapshot.modelId))
        .limit(1)
        .for("update");
    }

    const existing = rows[0];
    if (existing === undefined) {
      throw new Error("Catalog upsert did not produce a row");
    }
    if (existing.metadataSource !== snapshot.metadataSource) {
      throw new ModelPolicyConflictError("Catalog model belongs to another gateway mode");
    }
    if (snapshot.validatedAt.getTime() < existing.validatedAt.getTime()) {
      throw new ModelPolicyConflictError("Catalog snapshot is older than stored metadata");
    }
    const safeUpdatedAt = latestDate(
      updatedAt,
      snapshot.validatedAt,
      existing.createdAt,
      existing.updatedAt,
      existing.refreshAttemptedAt,
    );
    await transaction
      .update(modelCatalog)
      .set({
        available: snapshot.available,
        canonicalSlug: snapshot.canonicalSlug,
        completionPricePerToken: snapshot.completionPricePerToken,
        contextLength: snapshot.contextLength,
        displayName: snapshot.displayName,
        inputModalities: snapshot.inputModalities,
        maximumOutputTokens: snapshot.maximumOutputTokens,
        outputModalities: snapshot.outputModalities,
        promptPricePerToken: snapshot.promptPricePerToken,
        refreshAttemptedAt: safeUpdatedAt,
        requestPriceUsd: snapshot.requestPriceUsd,
        supportedParameters: snapshot.supportedParameters,
        updatedAt: safeUpdatedAt,
        validatedAt: snapshot.validatedAt,
      })
      .where(eq(modelCatalog.id, existing.id));
    return existing.id;
  }

  async function approveCatalogSnapshot(
    workspaceId: string,
    mode: ModelPolicyMode,
    snapshot: CatalogModelSnapshot,
  ): Promise<AdminModelCatalogItem> {
    const approvedAt = options.now();
    assertValidatedSnapshot(snapshot, mode, approvedAt);
    const catalogId = await database.transaction(async (transaction) => {
      const workspaceRows = await transaction
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
        .for("update");
      if (workspaceRows[0] === undefined) {
        throw new ModelPolicyUnavailableError("Workspace model policy is unavailable");
      }
      const id = await upsertCatalogSnapshot(transaction, snapshot, approvedAt);
      await transaction
        .insert(workspaceCatalogApprovals)
        .values({ createdAt: approvedAt, modelCatalogId: id, workspaceId })
        .onConflictDoNothing();
      return id;
    });
    const rows = await database
      .select(catalogSelection())
      .from(modelCatalog)
      .where(eq(modelCatalog.id, catalogId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Approved catalog row disappeared");
    }
    return toCatalogItem(row);
  }

  async function claimAdminCatalogRefresh(
    workspaceId: string,
    mode: ModelPolicyMode,
    ownerId: string,
    cursor: string | null,
    at = options.now(),
  ): Promise<AdminCatalogRefreshClaim> {
    if (mode !== "openrouter") {
      throw new ModelPolicyConflictError("Catalog refresh requires OpenRouter mode");
    }
    assertUuid(ownerId, "Catalog refresh owner");
    const after =
      cursor === null ? null : decodeCursor(cursor, workspaceId, catalogRefreshCursorKind);
    return database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          ...catalogSelection(),
          refreshLeaseExpiresAt: modelCatalog.refreshLeaseExpiresAt,
        })
        .from(workspaceCatalogApprovals)
        .innerJoin(modelCatalog, eq(modelCatalog.id, workspaceCatalogApprovals.modelCatalogId))
        .where(
          and(
            eq(workspaceCatalogApprovals.workspaceId, workspaceId),
            eq(modelCatalog.metadataSource, "openrouter"),
            after === null
              ? undefined
              : or(
                  gt(modelCatalog.openRouterModelId, after.modelId),
                  and(
                    eq(modelCatalog.openRouterModelId, after.modelId),
                    gt(modelCatalog.id, after.catalogId),
                  ),
                ),
          ),
        )
        .orderBy(asc(modelCatalog.openRouterModelId), asc(modelCatalog.id))
        .limit(costControlTuning.catalogAdministrationBatchSize + 1)
        .for("update");
      const visible = rows.slice(0, costControlTuning.catalogAdministrationBatchSize);
      if (
        visible.some(
          ({ refreshLeaseExpiresAt }) =>
            refreshLeaseExpiresAt !== null && refreshLeaseExpiresAt.getTime() > at.getTime(),
        )
      ) {
        throw new CatalogRefreshActiveError();
      }
      const ids = visible.map(({ catalogId }) => catalogId);
      if (ids.length > 0) {
        await transaction
          .update(modelCatalog)
          .set({
            refreshLeaseExpiresAt: new Date(at.getTime() + costControlTuning.catalogRefreshLeaseMs),
            refreshLeaseOwner: ownerId,
          })
          .where(inArray(modelCatalog.id, ids));
      }
      const last = visible.at(-1);
      return Object.freeze({
        modelIds: Object.freeze(visible.map(({ modelId }) => modelId)),
        nextCursor:
          rows.length <= costControlTuning.catalogAdministrationBatchSize || last === undefined
            ? null
            : encodeCursor(last, workspaceId, catalogRefreshCursorKind),
        ownerId,
      });
    });
  }

  return Object.freeze({ approveCatalogSnapshot, claimAdminCatalogRefresh, listAdminCatalog });
}
