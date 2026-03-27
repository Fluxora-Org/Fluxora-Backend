export type ContractEventRecord = {
  eventId: string;
  ledger: number;
  contractId: string;
  topic: string;
  txHash: string;
  txIndex: number;
  operationIndex: number;
  eventIndex: number;
  payload: Record<string, unknown>;
  happenedAt: string;
  ingestedAt?: string;
};

export type IngestContractEventsRequest = {
  events: ContractEventRecord[];
};

export type IngestContractEventsResult = {
  insertedCount: number;
  duplicateCount: number;
  insertedEventIds: string[];
  duplicateEventIds: string[];
};

export type IndexerStoreKind = 'memory' | 'postgres';

export type IndexerDependencyState = 'healthy' | 'degraded' | 'unavailable';

export type IndexerHealthSnapshot = {
  dependency: IndexerDependencyState;
  store: IndexerStoreKind;
  lastSuccessfulIngestAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  acceptedBatchCount: number;
  acceptedEventCount: number;
  duplicateEventCount: number;
};
