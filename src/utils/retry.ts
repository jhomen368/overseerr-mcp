// ... existing code ...

interface RetryOptions {
  maxAttempts?: number;
  backoffMs?: number[];
  shouldRetry?: (error: any) => boolean;
}

/**
 * Retries a function with exponential backoff
 * Default: 3 attempts with 100ms, 500ms, 1000ms delays
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    backoffMs = [100, 500, 1000],
    shouldRetry = (error: any) => {
      // Retry on network errors, timeouts, and 5xx errors
      if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') return true;
      if (error.response?.status >= 500) return true;
      return false;
    },
  } = options;

  let lastError: any;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry if we shouldn't or if this was the last attempt
      if (!shouldRetry(error) || attempt === maxAttempts - 1) {
        throw error;
      }

      // Wait before retrying
      const delay = backoffMs[attempt] || backoffMs[backoffMs.length - 1];
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Batch process items with retry logic for each item
 * Continues processing even if individual items fail
 */
export async function batchWithRetry<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  options: RetryOptions = {}
): Promise<Array<{ success: boolean; result?: R; error?: any; item: T }>> {
  const results = await Promise.allSettled(
    items.map(item =>
      withRetry(() => processor(item), options)
        .then(result => ({ success: true, result, item }))
        .catch(error => ({ success: false, error, item }))
    )
  );

  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      return {
        success: false,
        error: result.reason,
        item: items[index],
      };
    }
  });
}