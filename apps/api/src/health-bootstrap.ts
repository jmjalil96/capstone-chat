import pino from "pino";
import { loadHealthBootstrapConfig } from "./config.js";
import { createHealthBootstrapServer } from "./health-bootstrap-server.js";
import { operationalErrorMetadata } from "./operator-error.js";

const logger = pino({ name: "capstone-chat-health-bootstrap" });

async function main(): Promise<void> {
  const config = loadHealthBootstrapConfig();
  const server = createHealthBootstrapServer({ deploymentRevision: config.deploymentRevision });
  const close = () => {
    server.close((error) => {
      if (error !== undefined) {
        logger.error(operationalErrorMetadata(error), "health bootstrap shutdown failed");
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });
  logger.info("health bootstrap ready");
}

main().catch((error: unknown) => {
  logger.fatal(operationalErrorMetadata(error), "health bootstrap failed");
  process.exitCode = 1;
});
