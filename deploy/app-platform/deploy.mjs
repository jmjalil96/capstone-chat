#!/usr/bin/env node
import {
  adoptInitialBaseline,
  evictUnsafeHistory,
  reconcileLiveRelease,
  runReleaseOperation,
} from "./release.mjs";

const operation = process.argv[2] ?? "deploy";

try {
  if (operation === "deploy") {
    await runReleaseOperation("deploy");
  } else if (operation === "adopt-initial") {
    await adoptInitialBaseline();
  } else if (operation === "history-eviction") {
    await evictUnsafeHistory();
  } else if (operation === "history-eviction-rehearsal") {
    await evictUnsafeHistory({ mode: "rehearsal" });
  } else if (operation === "reconcile") {
    await reconcileLiveRelease();
  } else {
    throw new Error("Deploy operation is invalid");
  }
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ errorName: error instanceof Error ? error.name : "Error", outcome: "failed" })}\n`,
  );
  process.exitCode = 1;
}
