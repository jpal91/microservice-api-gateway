import type { AxiosError } from "axios";

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

  shouldRetry(err: AxiosError, attempt: number) {
    if (err.response) {
      return (
        attempt < this.maxRetries &&
        this.retryableStatus.has(err.response.status)
      );
    } else {
      return false;
    }
  }

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
