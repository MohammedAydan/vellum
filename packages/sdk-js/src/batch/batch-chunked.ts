/**
 * @vellum/sdk-js - Auto-Chunked Bulk Writes
 *
 * Splits arbitrarily large write arrays into server-safe `batchWrite` chunks
 * (default 500 ops/batch) with bounded concurrency (default 4) and full
 * `AbortSignal` cancellation support.
 */

import { createAbortError } from "../core/backoff.js";
import type {
  BatchWriteChunkedOptions,
  BatchWriteChunkedResult,
  RequestOptions,
} from "../types.js";

const DEFAULT_BATCH_CHUNK_SIZE = 500;
const DEFAULT_BATCH_CONCURRENCY = 4;

/** Split an array into contiguous slices of at most `chunkSize` elements. */
export function chunkOperations<T>(items: readonly T[], chunkSize: number): T[][] {
  const safeSize = Math.max(1, Math.floor(chunkSize));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += safeSize) {
    chunks.push(items.slice(i, i + safeSize));
  }
  return chunks;
}

export interface BatchWriteExecutor {
  batchWrite(writes: unknown[], options?: RequestOptions): Promise<unknown>;
}

/**
 * Execute an arbitrarily large array of write operations as server-safe
 * `batchWrite` chunks with bounded concurrency and `AbortSignal` support.
 */
export async function batchWriteChunked(
  executor: BatchWriteExecutor,
  operations: readonly unknown[],
  options: BatchWriteChunkedOptions = {}
): Promise<BatchWriteChunkedResult> {
  const { signal, onProgress } = options;
  if (signal?.aborted) {
    throw createAbortError(signal);
  }

  if (operations.length === 0) {
    return {
      totalOperations: 0,
      totalChunks: 0,
      results: [],
    };
  }

  const chunkSize =
    typeof options.chunkSize === "number" && Number.isFinite(options.chunkSize) && options.chunkSize >= 1
      ? Math.floor(options.chunkSize)
      : DEFAULT_BATCH_CHUNK_SIZE;
  const concurrency =
    typeof options.concurrency === "number" && Number.isFinite(options.concurrency) && options.concurrency >= 1
      ? Math.floor(options.concurrency)
      : DEFAULT_BATCH_CONCURRENCY;

  const chunks = chunkOperations(operations, chunkSize);
  const totalChunks = chunks.length;
  const totalOperations = operations.length;
  const results: unknown[] = new Array<unknown>(totalChunks);

  let nextChunkIndex = 0;
  let completedChunks = 0;
  let completedOperations = 0;
  let hasError = false;
  let firstError: unknown = null;

  const workerCount = Math.min(concurrency, totalChunks);

  async function runWorker(): Promise<void> {
    while (!hasError) {
      if (signal?.aborted) {
        hasError = true;
        firstError = createAbortError(signal);
        return;
      }
      const chunkIndex = nextChunkIndex;
      if (chunkIndex >= totalChunks) return;
      nextChunkIndex += 1;

      const chunk = chunks[chunkIndex];
      if (!chunk) return;

      try {
        const res = await executor.batchWrite(chunk, signal ? { signal } : {});
        results[chunkIndex] = res;
        completedChunks += 1;
        completedOperations += chunk.length;
        if (onProgress) {
          try {
            onProgress({
              completedChunks,
              totalChunks,
              completedOperations,
              totalOperations,
              chunkIndex,
            });
          } catch {
            // Progress hooks are advisory; never abort a batch on callback error.
          }
        }
      } catch (err: unknown) {
        if (!hasError) {
          hasError = true;
          firstError = err;
        }
        return;
      }
    }
  }

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(runWorker());
  }
  await Promise.all(workers);

  if (hasError) {
    throw firstError;
  }

  return {
    totalOperations,
    totalChunks,
    results,
  };
}
