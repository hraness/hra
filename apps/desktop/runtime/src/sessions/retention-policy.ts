/** Shared live-state and restart-hydration bounds. */
export const SESSION_RETENTION_POLICY = Object.freeze({
  maxFactsPerBatch: 16_384,
  maxMetadataThreadsPerAccount: 256,
  maxHistoryThreadsPerAccount: 32,
  maxDisplayItemsPerThread: 256,
  maxDisplayBytesPerThread: 1 * 1_024 * 1_024,
  maxDisplayBytesTotal: 16 * 1_024 * 1_024,
  maxStreamingDeltasPerItem: 4_096,
  maxActiveItemsPerTurn: 256,
  maxActiveTurnsPerThread: 1,
  maxPendingInteractionsPerAccount: 128,
  maxPendingOperationsPerAccount: 128,
  maxThreadTombstonesPerAccount: 512,
});
