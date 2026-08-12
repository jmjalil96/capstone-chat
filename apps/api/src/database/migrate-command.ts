import pino from "pino";
import { loadMigrationConfig } from "../config.js";
import { operationalErrorMetadata } from "../operator-error.js";
import { migrateDatabase } from "./migrate.js";

const logger = pino({ name: "capstone-chat-migrations" });

async function main(): Promise<void> {
  const config = loadMigrationConfig();
  await migrateDatabase(config.databaseUrl);
  logger.info("database migrations applied");
}

main().catch((error: unknown) => {
  logger.fatal(operationalErrorMetadata(error), "database migration failed");
  process.exitCode = 1;
});
