import { logger } from './logger';

export interface RetryOptions {
  attempts: number;
  delayMs: number;
  backoffMultiplier?: number;
  onRetry?: (error: Error, attempt: number) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const { attempts, delayMs, backoffMultiplier = 2, onRetry } = opts;
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt === attempts) break;

      const waitMs = delayMs * Math.pow(backoffMultiplier, attempt - 1);
      if (onRetry) onRetry(lastError, attempt);
      else logger.warn({ attempt, waitMs, error: lastError.message }, 'Retrying after error');

      await sleep(waitMs);
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
