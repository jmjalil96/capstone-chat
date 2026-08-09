import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import type { AppDatabase } from "../database/database.js";

export const CLIENT_ERROR_GLOBAL_LIMIT_PER_MINUTE = 200;
export const CLIENT_ERROR_IP_LIMIT_PER_MINUTE = 10;
export const CLIENT_ERROR_RATE_LIMIT_WINDOW_MS = 60_000;
export const CLIENT_ERROR_STALE_CLEANUP_LIMIT = 64;

type RateLimitScope = "client" | "global";

const globalLimitReached = new Error("Client-error global rate limit reached");

interface IncrementRow {
  readonly requestCount: number;
}

export interface ClientErrorRateLimiter {
  allow(clientAddress: string): Promise<boolean>;
}

function normalizeClientAddress(clientAddress: string): string | null {
  const address = clientAddress.trim();
  const version = isIP(address);
  if (version === 4) {
    return address;
  }
  if (version !== 6) {
    return null;
  }

  // URL canonicalization produces one stable textual representation for equivalent IPv6 values.
  return new URL(`http://[${address}]`).hostname.slice(1, -1);
}

function rateLimitHash(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export function createClientErrorRateLimiter(
  database: AppDatabase,
  hashSecret: string,
  now: () => Date = () => new Date(),
): ClientErrorRateLimiter {
  if (hashSecret.length < 32) {
    throw new Error("Client-error rate-limit hash secret must contain at least 32 characters");
  }

  async function increment(
    transaction: Parameters<Parameters<AppDatabase["transaction"]>[0]>[0],
    input: {
      readonly expiresAt: Date;
      readonly keyHash: string;
      readonly limit: number;
      readonly scope: RateLimitScope;
      readonly windowStartedAt: Date;
    },
  ): Promise<boolean> {
    const result = await transaction.execute(sql<IncrementRow>`
      INSERT INTO client_error_rate_limit_windows (
        scope,
        key_hash,
        window_started_at,
        request_count,
        expires_at
      ) VALUES (
        ${input.scope},
        ${input.keyHash},
        ${input.windowStartedAt},
        1,
        ${input.expiresAt}
      )
      ON CONFLICT (scope, key_hash, window_started_at)
      DO UPDATE SET request_count = client_error_rate_limit_windows.request_count + 1
      WHERE client_error_rate_limit_windows.request_count < ${input.limit}
      RETURNING request_count AS "requestCount"
    `);
    return (result.rows as unknown as readonly IncrementRow[]).length === 1;
  }

  return Object.freeze({
    async allow(clientAddress: string): Promise<boolean> {
      const normalizedAddress = normalizeClientAddress(clientAddress);
      if (normalizedAddress === null) {
        return false;
      }

      const current = now();
      const windowStartedAt = new Date(
        Math.floor(current.getTime() / CLIENT_ERROR_RATE_LIMIT_WINDOW_MS) *
          CLIENT_ERROR_RATE_LIMIT_WINDOW_MS,
      );
      const expiresAt = new Date(windowStartedAt.getTime() + CLIENT_ERROR_RATE_LIMIT_WINDOW_MS);

      try {
        return await database.transaction(async (transaction) => {
          await transaction.execute(sql`
            WITH stale AS (
              SELECT ctid
              FROM client_error_rate_limit_windows
              WHERE expires_at <= ${current}
              ORDER BY expires_at
              LIMIT ${CLIENT_ERROR_STALE_CLEANUP_LIMIT}
            )
            DELETE FROM client_error_rate_limit_windows
            WHERE ctid IN (SELECT ctid FROM stale)
          `);

          const clientAllowed = await increment(transaction, {
            expiresAt,
            keyHash: rateLimitHash(hashSecret, normalizedAddress),
            limit: CLIENT_ERROR_IP_LIMIT_PER_MINUTE,
            scope: "client",
            windowStartedAt,
          });
          if (!clientAllowed) {
            return false;
          }

          const globalAllowed = await increment(transaction, {
            expiresAt,
            keyHash: rateLimitHash(hashSecret, "capstone-client-errors-global"),
            limit: CLIENT_ERROR_GLOBAL_LIMIT_PER_MINUTE,
            scope: "global",
            windowStartedAt,
          });
          if (!globalAllowed) {
            throw globalLimitReached;
          }
          return true;
        });
      } catch (error: unknown) {
        if (error === globalLimitReached) {
          return false;
        }
        throw error;
      }
    },
  });
}
