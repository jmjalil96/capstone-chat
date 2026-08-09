export const costControlTuning = Object.freeze({
  catalogAdministrationBatchSize: 50,
  catalogRefreshIntervalMs: 60 * 60 * 1_000,
  catalogRefreshLeaseMs: 2 * 60 * 1_000,
  privacyAttestationLifetimeMs: 30 * 24 * 60 * 60 * 1_000,
  reconciliationBatchSize: 25,
  reconciliationIntervalMs: 30_000,
  reservationExpiryMs: 15 * 60 * 1_000,
  tokenEstimatePerMessageFraming: 16,
  tokenEstimateRequestFraming: 32,
});

export function conservativeTokenEstimate(messages: readonly string[]): bigint {
  const framing =
    costControlTuning.tokenEstimateRequestFraming +
    costControlTuning.tokenEstimatePerMessageFraming * messages.length;
  const contentBytes = messages.reduce(
    (total, message) => total + Buffer.byteLength(message, "utf8"),
    0,
  );
  return BigInt(framing + contentBytes);
}
