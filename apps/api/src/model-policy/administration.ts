import type { CursorCodec } from "../conversations/cursor.js";
import type { AppDatabase, AppDatabaseExecutor } from "../database/database.js";
import { createCatalogAdministration } from "./catalog-administration.js";
import { createPolicyAdministration } from "./policy-administration.js";

export interface ModelPolicyAdministrationOptions {
  readonly cursorCodec?: CursorCodec;
  readonly now: () => Date;
  readonly privacyIsVerified: (
    database: AppDatabaseExecutor,
    workspaceId: string,
    at: Date,
  ) => Promise<boolean>;
}

export function createModelPolicyAdministration(
  database: AppDatabase,
  options: ModelPolicyAdministrationOptions,
) {
  const catalog = createCatalogAdministration(database, {
    ...(options.cursorCodec === undefined ? {} : { cursorCodec: options.cursorCodec }),
    now: options.now,
  });
  const policy = createPolicyAdministration(database, options);
  return Object.freeze({ ...catalog, ...policy });
}

export type ModelPolicyAdministration = ReturnType<typeof createModelPolicyAdministration>;
