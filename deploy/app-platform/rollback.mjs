#!/usr/bin/env node
import { runReleaseOperation } from "./release.mjs";

try {
  await runReleaseOperation("rollback");
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ errorName: error instanceof Error ? error.name : "Error", outcome: "failed" })}\n`,
  );
  process.exitCode = 1;
}
