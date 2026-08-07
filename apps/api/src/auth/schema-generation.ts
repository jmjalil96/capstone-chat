import { betterAuth } from "better-auth";

// The pinned CLI reads these schema-relevant options with its PostgreSQL Drizzle mock adapter.
// Keeping generation disconnected prevents a schema review command from touching a live database.
export const auth = betterAuth({
  baseURL: "http://localhost.invalid",
  emailAndPassword: {
    enabled: true,
  },
  rateLimit: {
    enabled: true,
    storage: "database",
  },
});
