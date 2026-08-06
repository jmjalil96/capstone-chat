import { defineConfig } from "drizzle-kit";
import { loadEnvironmentFile } from "./src/environment.js";

loadEnvironmentFile();

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl === undefined || databaseUrl.trim() === "") {
  throw new Error("DATABASE_URL is required to run Drizzle commands");
}

export default defineConfig({
  dbCredentials: {
    url: databaseUrl,
  },
  dialect: "postgresql",
  out: "./migrations",
  schema: "./src/database/schema.ts",
  strict: true,
  verbose: true,
});
