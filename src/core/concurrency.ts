function normalizeConcurrency(value: number | undefined, fallback = 8): number {
  return Math.max(1, Math.floor(value ?? fallback));
}

export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number | undefined,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(normalizeConcurrency(concurrency), items.length);

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await mapper(items[index]!, index);
    }
  }

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      await worker();
    })
  );
  return results;
}

export async function serializeByKey<T>(
  tails: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = tails.get(key);
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(key, current);
  if (previous) {
    await previous;
  }
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(key) === current) {
      tails.delete(key);
    }
  }
}
