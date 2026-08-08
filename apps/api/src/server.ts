import pino from "pino";
import { loadConfig } from "./config.js";
import { operationalErrorMetadata } from "./operator-error.js";
import { installShutdownHandlers, startServer } from "./start.js";

const bootstrapLogger = pino({ name: "capstone-chat-api" });

async function main(): Promise<void> {
  const config = loadConfig();
  const application = await startServer(config);
  installShutdownHandlers(application);
}

main().catch((error: unknown) => {
  bootstrapLogger.fatal(operationalErrorMetadata(error), "api failed to start");
  process.exitCode = 1;
});
