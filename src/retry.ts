import { AxiosError } from "axios";

export interface RetryStrategyOptions {
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  retryableStatus?: Array<number>;
}

class RetryStrategy {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  retryableStatus: Set<number>;

  constructor(opts?: RetryStrategyOptions) {
    this.maxRetries = opts?.maxRetries ?? 3;
    this.baseDelay = opts?.baseDelay ?? 1000;
    this.maxDelay = opts?.maxDelay ?? 5000;
    this.retryableStatus = opts?.retryableStatus
      ? new Set(opts.retryableStatus)
      : new Set([500, 502, 503, 504]);
  }

  /**
   * Determines if a request to a service should be retired.
   *
   * Technically only AxiosErrors should be called with this. If a different error type is called
   * it's most likely due to some internal issue in which case we should automatically not retry.
   * Otherwise if the status indicates a retry may be possible, we try again.
   *
   * @param err - Error thrown from the axios request
   * @param attempt - The number of attempts made on this request
   */
  shouldRetry(err: AxiosError | unknown, attempt: number) {
    if (err instanceof AxiosError && err.response) {
      return (
        attempt < this.maxRetries &&
        this.retryableStatus.has(err.response.status)
      );
    } else {
      return false;
    }
  }

  /**
   * Creates an exponential backoff with jitter to slow subsequent request retries
   *
   * @param {number} attempt - The number of times the request has been attempted
   */
  async delay(attempt: number) {
    const exponentialDelay = Math.min(
      this.maxDelay,
      this.baseDelay * Math.pow(2, attempt),
    );
    const jitter = Math.random() * 10;

    await new Promise((resolve) => {
      setTimeout(resolve, exponentialDelay + jitter);
    });
  }
}

export default RetryStrategy;
