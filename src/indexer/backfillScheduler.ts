export interface BackfillBatch<T = unknown> {
  index: number;
  data: T;
}

export type BackfillHandler<T = unknown> = (batch: BackfillBatch<T>) => Promise<void>;

export interface BackfillOptions<T = unknown> {
  batches: BackfillBatch<T>[];
  concurrency: number;
  initialCheckpoint?: number;
  retryLimit?: number;
  retryDelayMs?: number;
  onCheckpoint?: (index: number) => void | Promise<void>;
  signal?: AbortSignal;
  handler: BackfillHandler<T>;
}

export async function runBackfill<T>(options: BackfillOptions<T>): Promise<number> {
  const { batches, concurrency, initialCheckpoint = -1, retryLimit = 3, retryDelayMs = 100, onCheckpoint, signal, handler } = options;
  const status = new Map<number, 'pending' | 'done' | 'failed'>();
  for (const b of batches) status.set(b.index, 'pending');
  const indices = batches.map((b) => b.index).sort((a, b) => a - b);
  let checkpoint = initialCheckpoint;
  let next = 0;
  let error: Error | null = null;

  const commit = async () => {
    while (status.get(checkpoint + 1) === 'done') checkpoint++;
    if (onCheckpoint && checkpoint > initialCheckpoint) await onCheckpoint(checkpoint);
  };

  const worker = async () => {
    while (!error && !signal?.aborted) {
      const pos = next++;
      if (pos >= indices.length) return;
      const index = indices[pos];
      for (let attempt = 1; attempt <= retryLimit; attempt++) {
        try {
          await handler({ index, data: batches[pos].data });
          status.set(index, 'done');
          await commit();
          break;
        } catch (err) {
          if (attempt === retryLimit) {
            error = err instanceof Error ? err : new Error(String(err));
            status.set(index, 'failed');
            break;
          }
          await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** (attempt - 1)));
          if (signal?.aborted) return;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, worker));
  if (error) throw error;
  return checkpoint;
}
