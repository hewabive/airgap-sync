export interface RetryOptions {
  delaysMs?: number[];
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (event: RetryEvent) => void;
}

export interface RetryEvent {
  attempt: number;
  delayMs: number;
  error: unknown;
  nextAttempt: number;
}

const defaultRetryDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000];

function isErrorWithName(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

function errorCause(error: Error): unknown {
  return 'cause' in error ? error.cause : undefined;
}

function isRetryableNetworkError(error: unknown): boolean {
  if (isErrorWithName(error, 'AbortError') || isErrorWithName(error, 'TimeoutError')) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  if (
    error.name === 'TypeError' &&
    (error.message === 'fetch failed' || error.message === 'terminated')
  ) {
    return true;
  }

  if (isRetryableNetworkError(errorCause(error))) {
    return true;
  }

  return [
    'aborted due to timeout',
    'fetch failed',
    'other side closed',
    'terminated',
    'ECONNRESET',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ETIMEDOUT',
    'ERR_STREAM_PREMATURE_CLOSE',
  ].some((code) => error.message.includes(code));
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export class HttpStatusError extends Error {
  readonly retryAfterMs: number | undefined;
  readonly status: number;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = 'HttpStatusError';
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

export function isRetryableFetchError(error: unknown): boolean {
  if (error instanceof HttpStatusError) {
    return isRetryableHttpStatus(error.status);
  }

  return isRetryableNetworkError(error);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const delaysMs = options.delaysMs ?? defaultRetryDelaysMs;
  const isRetryable = options.isRetryable ?? isRetryableNetworkError;
  let attempt = 1;

  for (;;) {
    try {
      return await operation();
    } catch (error) {
      const configuredDelayMs = delaysMs[attempt - 1];
      if (configuredDelayMs === undefined || !isRetryable(error)) {
        throw error;
      }
      const delayMs =
        error instanceof HttpStatusError && error.retryAfterMs !== undefined
          ? Math.max(configuredDelayMs, error.retryAfterMs)
          : configuredDelayMs;

      options.onRetry?.({
        attempt,
        delayMs,
        error,
        nextAttempt: attempt + 1,
      });
      await sleep(delayMs);
      attempt++;
    }
  }
}
