export const generationTuning = Object.freeze({
  backpressureTimeoutMilliseconds: 5_000,
  checkpointBytes: 1_024,
  checkpointMilliseconds: 250,
  durableStatePollMilliseconds: 250,
  fakeChunkDelayMilliseconds: 400,
  gracefulDrainMilliseconds: 10_000,
  maximumAssistantBytes: 1_048_576,
  maximumContextBytes: 1_048_576,
  maximumNdjsonLineBytes: 65_536,
  messageBytes: 32_768,
  requestBodyBytes: 69_632,
});
