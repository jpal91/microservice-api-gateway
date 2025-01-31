import { AxiosError } from "axios";
import { ApiGatewayError } from "./api-gateway";

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
  private _retryableStatus: Set<number> = new Set([500, 502, 503, 504]);

  constructor(opts?: RetryStrategyOptions) {
    this.maxRetries = opts?.maxRetries ?? 3;
    this.baseDelay = opts?.baseDelay ?? 1000;
    this.maxDelay = opts?.maxDelay ?? 5000;
    opts?.retryableStatus && (this.retryableStatus = opts.retryableStatus);
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
    // Request timeout, go ahead and try again until max is hit
    if (err instanceof AxiosError && err?.code === "ECONNABORTED") {
      return attempt < this.maxRetries;
    } else if (err instanceof AxiosError && err.response) {
      return (
        attempt < this.maxRetries &&
        this.retryableStatus.has(err.response.status)
      );
    } else if (err instanceof ApiGatewayError) {
      return attempt < this.maxRetries && this.retryableStatus.has(err.status);
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

  get retryableStatus(): Set<number> {
    return this._retryableStatus;
  }

  set retryableStatus(statuses: number[]) {
    this._retryableStatus = new Set(statuses);
  }
}

export default RetryStrategy;
