import { generationTuning } from "./generations/settings.js";
import { emailShutdownMaximumMilliseconds } from "./identity/email-lifecycle.js";
import { newRelicLogMirrorTuning } from "./observability/new-relic-log-mirror.js";
import { telemetryTuning } from "./observability/telemetry-contract.js";
import { httpServerTuning } from "./security/http.js";

// Outer lifecycle fences need a small completion margin beyond each adapter's own exact timer so
// same-deadline timer ordering does not report a successful bounded shutdown as a timeout.
const adapterCompletionHeadroomMilliseconds = 1_000;
const telemetryShutdownMaximumMilliseconds =
  telemetryTuning.shutdownTimeoutMs * 2 + adapterCompletionHeadroomMilliseconds;
const logMirrorShutdownMaximumMilliseconds =
  newRelicLogMirrorTuning.shutdownTimeoutMs + adapterCompletionHeadroomMilliseconds;
const databasePoolShutdownMaximumMilliseconds = 2_000;
const workFenceMaximumMilliseconds =
  httpServerTuning.ordinaryDrainMilliseconds +
  generationTuning.gracefulDrainMilliseconds +
  httpServerTuning.shutdownCleanupMilliseconds;
const finalResourceMaximumMilliseconds = Math.max(
  emailShutdownMaximumMilliseconds,
  databasePoolShutdownMaximumMilliseconds,
);
const applicationMaximumMilliseconds =
  workFenceMaximumMilliseconds +
  finalResourceMaximumMilliseconds +
  logMirrorShutdownMaximumMilliseconds +
  telemetryShutdownMaximumMilliseconds;
const platformDelayMilliseconds = 300_000;

export const applicationShutdownBudget = Object.freeze({
  applicationMaximumMilliseconds,
  databasePoolShutdownMaximumMilliseconds,
  emailShutdownMaximumMilliseconds,
  finalResourceMaximumMilliseconds,
  forcedStreamCleanupMilliseconds: httpServerTuning.shutdownCleanupMilliseconds,
  httpAndMaintenanceMaximumMilliseconds: workFenceMaximumMilliseconds,
  logMirrorShutdownMaximumMilliseconds,
  ordinaryDrainMilliseconds: httpServerTuning.ordinaryDrainMilliseconds,
  platformDelayMilliseconds,
  platformHeadroomMilliseconds: platformDelayMilliseconds - applicationMaximumMilliseconds,
  streamDrainMilliseconds: generationTuning.gracefulDrainMilliseconds,
  telemetryShutdownMaximumMilliseconds,
  workFenceMaximumMilliseconds,
});
