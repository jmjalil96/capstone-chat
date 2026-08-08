export const openRouterTuning = Object.freeze({
  catalogTimeoutMilliseconds: 30_000,
  firstVisibleTokenTimeoutMilliseconds: 30_000,
  headerTimeoutMilliseconds: 10_000,
  inactivityTimeoutMilliseconds: 30_000,
  lookupTimeoutMilliseconds: 10_000,
  maximumErrorBodyBytes: 16 * 1024,
  maximumJsonBodyBytes: 8 * 1024 * 1024,
  maximumSseEventBytes: 64 * 1024,
  maximumSseQueueBytes: 256 * 1024,
  maximumSseQueueEvents: 128,
  totalTimeoutMilliseconds: 120_000,
});
