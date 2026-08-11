import { generationTuning } from "./generations/settings.js";
import { emailShutdownMaximumMilliseconds } from "./identity/email-lifecycle.js";
import { telemetryTuning } from "./observability/telemetry-contract.js";
import { httpServerTuning } from "./security/http.js";

const telemetryShutdownMaximumMilliseconds = telemetryTuning.shutdownTimeoutMs * 2;
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
  telemetryShutdownMaximumMilliseconds;
const platformDelayMilliseconds = 300_000;

export const applicationShutdownBudget = Object.freeze({
  applicationMaximumMilliseconds,
  databasePoolShutdownMaximumMilliseconds,
  emailShutdownMaximumMilliseconds,
  finalResourceMaximumMilliseconds,
  forcedStreamCleanupMilliseconds: httpServerTuning.shutdownCleanupMilliseconds,
  httpAndMaintenanceMaximumMilliseconds: workFenceMaximumMilliseconds,
  ordinaryDrainMilliseconds: httpServerTuning.ordinaryDrainMilliseconds,
  platformDelayMilliseconds,
  platformHeadroomMilliseconds: platformDelayMilliseconds - applicationMaximumMilliseconds,
  streamDrainMilliseconds: generationTuning.gracefulDrainMilliseconds,
  telemetryShutdownMaximumMilliseconds,
  workFenceMaximumMilliseconds,
});
