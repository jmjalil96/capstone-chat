import { desc, eq } from "drizzle-orm";
import type { AppDatabase } from "../database/database.js";
import { operationalRecoveryMarkers } from "../database/observability-schema.js";

export type RecoveryMarkerKind = "post" | "pre";

export interface RecoveryMarker {
  readonly createdAt: Date;
  readonly id: string;
  readonly kind: RecoveryMarkerKind;
}

export interface RecoveryMarkerService {
  create(kind: RecoveryMarkerKind): Promise<RecoveryMarker>;
  delete(id: string): Promise<boolean>;
  list(): Promise<readonly RecoveryMarker[]>;
}

export function createRecoveryMarkerService(database: AppDatabase): RecoveryMarkerService {
  return Object.freeze({
    async create(kind: RecoveryMarkerKind): Promise<RecoveryMarker> {
      const rows = await database.insert(operationalRecoveryMarkers).values({ kind }).returning({
        createdAt: operationalRecoveryMarkers.createdAt,
        id: operationalRecoveryMarkers.id,
        kind: operationalRecoveryMarkers.kind,
      });
      const marker = rows[0];
      if (marker === undefined || (marker.kind !== "pre" && marker.kind !== "post")) {
        throw new Error("Recovery marker insert did not return a valid marker");
      }
      return Object.freeze({ ...marker, kind: marker.kind });
    },

    async delete(id: string): Promise<boolean> {
      const rows = await database
        .delete(operationalRecoveryMarkers)
        .where(eq(operationalRecoveryMarkers.id, id))
        .returning({ id: operationalRecoveryMarkers.id });
      return rows.length === 1;
    },

    async list(): Promise<readonly RecoveryMarker[]> {
      const rows = await database
        .select({
          createdAt: operationalRecoveryMarkers.createdAt,
          id: operationalRecoveryMarkers.id,
          kind: operationalRecoveryMarkers.kind,
        })
        .from(operationalRecoveryMarkers)
        .orderBy(desc(operationalRecoveryMarkers.createdAt), desc(operationalRecoveryMarkers.id))
        .limit(100);
      return Object.freeze(
        rows.map((marker) => {
          if (marker.kind !== "pre" && marker.kind !== "post") {
            throw new Error("Recovery marker query returned an invalid marker kind");
          }
          return Object.freeze({ ...marker, kind: marker.kind });
        }),
      );
    },
  });
}
