import pino from "pino";
import { loadConfig } from "../config.js";
import { migrateDatabase } from "./migrate.js";

const logger = pino({ name: "capstone-chat-migrations" });

async function main(): Promise<void> {
  const config = loadConfig();
  await migrateDatabase(config.databaseUrl);
  logger.info("database migrations applied");
}

main().catch((error: unknown) => {
  logger.fatal(
    { errorName: error instanceof Error ? error.name : "UnknownError" },
    "database migration failed",
  );
  process.exitCode = 1;
});
