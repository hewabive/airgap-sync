import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpStatusError, isRetryableFetchError, retry } from '../src/core/retry.js';

describe('retry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('honors an HTTP Retry-After delay when it exceeds the configured backoff', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const retryEvents: { delayMs: number }[] = [];
    const result = retry(
      () => {
        attempts++;
        if (attempts === 1) {
          return Promise.reject(new HttpStatusError('rate limited', 429, 50));
        }
        return Promise.resolve('ok');
      },
      {
        delaysMs: [10],
        isRetryable: isRetryableFetchError,
        onRetry: (event) => retryEvents.push({ delayMs: event.delayMs }),
      }
    );

    await vi.advanceTimersByTimeAsync(49);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('ok');
    expect(retryEvents).toEqual([{ delayMs: 50 }]);
  });
});
