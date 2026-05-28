export interface ConcurrencyOptions {
  readonly isCancelled?: () => boolean;
  readonly onProgress?: (completed: number, total: number) => void;
  readonly yieldEvery?: number;
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
  options: ConcurrencyOptions = {},
): Promise<R[]> {
  const results = new Array<R | undefined>(values.length);
  let nextIndex = 0;
  let completed = 0;
  const safeYieldEvery = Math.max(1, Math.floor(options.yieldEvery ?? 25));
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (true) {
      if (options.isCancelled?.() === true) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      const value = values[index];
      if (value === undefined) continue;
      results[index] = await mapper(value, index);
      completed += 1;
      options.onProgress?.(completed, values.length);
      if (completed % safeYieldEvery === 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    }
  });
  await Promise.all(workers);
  return results.filter((result): result is R => result !== undefined);
}
