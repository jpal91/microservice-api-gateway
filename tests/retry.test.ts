import { ApiGatewayError } from "@app/api-gateway";
import RetryStrategy from "@app/retry";

describe("RetryStrategy", () => {
  let rt: RetryStrategy;

  beforeEach(() => {
    rt = new RetryStrategy();
  });

  test("each delay is longer", async () => {
    rt.baseDelay = 5;
    await rt.delay(0);

    const start = Date.now();
    await rt.delay(1);

    const endFirst = Date.now();
    const durationFirst = endFirst - start;
    await rt.delay(2);

    const endSecond = Date.now();
    const durationSecond = endSecond - endFirst;
    expect(durationSecond).toBeGreaterThan(durationFirst);
    await rt.delay(3);

    const endThird = Date.now();
    const durationLast = endThird - endSecond;
    expect(durationLast).toBeGreaterThan(durationSecond);
  });

  test("does not exceed maximum", async () => {
    rt.baseDelay = 1000;
    rt.maxDelay = 5;
    const now = Date.now();
    await rt.delay(1);

    const after = Date.now();
    // Arbitrary but giving it a little wiggle room
    expect(after - now).toBeLessThan(100);
  });

  test("it rejects after too many retries", () => {
    rt.maxRetries = 5;
    const error = new ApiGatewayError(500, "err");

    const attempt1 = rt.shouldRetry(error, 1);
    expect(attempt1).toBe(true);

    const attempt2 = rt.shouldRetry(error, 6);
    expect(attempt2).toBe(false);
  });

  test("it rejects on non filtered status", () => {
    const error = new ApiGatewayError(502, "err");

    const good = rt.shouldRetry(error, 1);
    expect(good).toBe(true);

    rt.retryableStatus = [500];
    const bad = rt.shouldRetry(error, 1);
    expect(bad).toBe(false);
  });

  test("it rejects on unhandled statuses", () => {
    const error = new Error("unknown");
    const res = rt.shouldRetry(error, 1);
    expect(res).toBe(false);
  });
});
