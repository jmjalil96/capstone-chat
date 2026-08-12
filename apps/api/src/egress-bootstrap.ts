import pino from "pino";
import { loadEgressBootstrapConfig } from "./config.js";
import { createEgressBootstrapServer } from "./egress-bootstrap-server.js";
import { operationalErrorMetadata } from "./operator-error.js";

const logger = pino({ name: "capstone-chat-egress-bootstrap" });

async function main(): Promise<void> {
  const config = loadEgressBootstrapConfig();
  const server = createEgressBootstrapServer({ deploymentRevision: config.deploymentRevision });
  const close = () => {
    server.close((error) => {
      if (error !== undefined) {
        logger.error(operationalErrorMetadata(error), "egress bootstrap shutdown failed");
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
  logger.info("egress bootstrap ready");
}

main().catch((error: unknown) => {
  logger.fatal(operationalErrorMetadata(error), "egress bootstrap failed");
  process.exitCode = 1;
});
