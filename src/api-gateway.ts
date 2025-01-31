import axios, {
  type AxiosStatic,
  AxiosError,
  type AxiosResponseHeaders,
  type RawAxiosResponseHeaders,
} from "axios";
import { Request, Response } from "express";
import type {
  ApiResponse,
  Logger,
  RegistrationResponse,
  Instance,
  ErrorResponse,
  ErrorCodes,
  HealthCheckResponse,
} from "microservice-ecommerce";
import RetryStrategy, { type RetryStrategyOptions } from "./retry";
import { RoundRobinBalancer, RandomBalancer } from "./load-balancer";
import { IncomingHttpHeaders } from "node:http2";

interface ProxyResponse {
  data: ApiResponse;
  status: number;
  headers?: RawAxiosResponseHeaders;
}

interface RegistryHeaders {
  "x-service-id": string;
  "x-service-token": string;
  [key: string]: string;
}

interface ApiGatewayOpts {
  requestTimeout?: number;
  totalRequestTimeout?: number;
  healthChecks?: boolean;
  healthCheckInterval?: number;
  healthCheckFailStrategy?: "try-again" | "shutdown";
  registryUrl?: string | URL;
  loadBalancerStrategy?: "round-robin" | "random";
  logger?: Logger;
  retryStrategy?: RetryStrategyOptions;
}

type Headers = { [key: string]: string | string[] | undefined };

type ApiGatewayStatus =
  | "GATEWAY_STARTING"
  | "REGISTRY_HEALTH_CHECK_FAIL"
  | "GATEWAY_ACTIVE"
  | "SHUTTING_DOWN"
  | "ATTEMPTING_REREGISTRATION";

const EXCLUDED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "authorization",
]);

const EXCLUDED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-internal-", // Any custom internal headers
]);

/**
 * Fitlers out headers that we don't want to pass to the requested service
 * @param headers
 */
const filterRequestHeaders = (headers?: IncomingHttpHeaders) => {
  const filtered: Headers = {};
  Object.entries(headers ?? {}).forEach(([k, v]) => {
    if (!EXCLUDED_REQUEST_HEADERS.has(k.toLowerCase())) {
      filtered[k] = v;
    }
  });

  return filtered;
};

const filterResponseHeaders = (
  headers?: RawAxiosResponseHeaders | AxiosResponseHeaders,
) => {
  const filtered: Headers = {};

  Object.entries(headers ?? {}).forEach(([key, value]) => {
    // Skip internal headers or excluded ones
    if (
      !key.toLowerCase().startsWith("x-internal-") &&
      !EXCLUDED_RESPONSE_HEADERS.has(key.toLowerCase())
    ) {
      filtered[key] = value as string | string[] | undefined;
    }
  });

  return filtered;
};

export class ApiGatewayError extends Error {
  status: number;
  code: ErrorCodes | string;
  data?: any;

  constructor(
    status: number,
    code: ErrorCodes | string,
    message?: string,
    data?: any,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }

  static fromStatus(status: ApiGatewayStatus) {
    let message: string;

    switch (status) {
      case "ATTEMPTING_REREGISTRATION":
        message =
          "Attempting to re-register with service registry. Check back shortly";
        break;
      case "REGISTRY_HEALTH_CHECK_FAIL":
        message =
          "Health check on service registry failed, attempting retry. Check back shortly";
        break;
      case "SHUTTING_DOWN":
        message = "Gateway has encountered an error and is shutting down";
        break;
      default:
        message = "Gateway is starting. Please check back shortly";
        break;
    }

    return new ApiGatewayError(503, status, message);
  }
}

class ApiGateway {
  private registryUrl: string;
  private port: number | undefined;

  status: ApiGatewayStatus = "GATEWAY_STARTING";
  timeout: number;
  healthChecks: boolean;
  healthCheckInterval: number;
  healthCheckTimeout: NodeJS.Timeout | undefined;
  healthCheckFailStrategy: "try-again" | "shutdown";
  totalTimeout: number;
  retryStrategy: RetryStrategy;
  client: AxiosStatic = axios;
  registryHeaders: RegistryHeaders | undefined;
  log: Logger;
  loadBalancer: RoundRobinBalancer | RandomBalancer;

  constructor(opts?: ApiGatewayOpts) {
    this.registryUrl = opts?.registryUrl
      ? opts.registryUrl.toString()
      : (process.env.REGISTRY_URL ?? "http://localhost:3002");
    this.log = opts?.logger ?? console;
    this.timeout = opts?.requestTimeout ?? 5000;
    this.totalTimeout = opts?.totalRequestTimeout ?? 10000;
    this.healthChecks = opts?.healthChecks ?? true;
    this.healthCheckInterval = opts?.healthCheckInterval ?? 10000;
    this.healthCheckFailStrategy = opts?.healthCheckFailStrategy ?? "try-again";

    switch (opts?.loadBalancerStrategy ?? "random") {
      case "round-robin":
        this.loadBalancer = new RoundRobinBalancer();
        break;
      default:
        this.loadBalancer = new RandomBalancer();
        break;
    }

    this.retryStrategy = new RetryStrategy(opts?.retryStrategy);

    process.once("SIGTERM", () => clearTimeout(this.healthCheckTimeout));

    this.log.info("Starting api gateway");
  }

  async register(port: number) {
    if (!process.env.SERVICE_REGISTRATION_KEY) {
      throw new Error("SERVICE_REGISTRATION_KEY is required to be set");
    }

    this.log.debug("Obtaining initial registration");

    let url: string;

    try {
      url = new URL("/service", this.registryUrl).toString();
    } catch {
      throw new Error("Invalid registryUrl value: " + this.registryUrl);
    }

    try {
      const { data } = await axios.post<RegistrationResponse>(
        url,
        {
          port,
          serviceType: "api-gateway",
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.SERVICE_REGISTRATION_KEY}`,
          },
        },
      );

      const { serviceId, token } = data;

      this.status = "GATEWAY_ACTIVE";
      this.port = port;
      this.registryHeaders = {
        "x-service-id": serviceId,
        "x-service-token": token,
      };

      this.log.debug("Api Gateway Registered");

      if (this.healthChecks) {
        // Start health checks
        this.healthCheckTimeout = setTimeout(
          () => this.checkRegistryHealth(),
          this.healthCheckInterval,
        );
      }

      return true;
    } catch (error) {
      this.log.error("Error connecting to service registry -", error);
      return false;
    }
  }

  async handleRequest(
    req: Request,
    res: Response,
    serviceName: string,
    remaining: string,
  ) {
    try {
      // Gateway hasn't finished registering yet, health check fail, shutting down
      if (this.status !== "GATEWAY_ACTIVE") {
        throw ApiGatewayError.fromStatus(this.status);
      }

      const instances = await this.getServices(serviceName);

      const service = this.loadBalancer.selectInstance(instances);
      const targetUrl = `https://${service.host}:${service.port}/${remaining}`;

      this.log.debug(
        "Service request - Name: ",
        serviceName,
        "Resolved url: ",
        targetUrl,
      );

      return this.getServiceResponse(req, res, targetUrl);
    } catch (e) {
      return this.handleErrResponse(res, e);
    }
  }

  async getServiceResponse(req: Request, res: Response, url: string) {
    const startTime = Date.now();
    let attempt = 0;
    const filteredHeaders = filterRequestHeaders(req.headers);

    // Attempts to fufill the request using the configured retry strategy
    while (true) {
      try {
        const { data, status, headers } = await axios.request<ApiResponse>({
          method: req.method,
          url,
          headers: filteredHeaders,
          data: req.body,
          timeout: this.timeout,
        });

        return this.handleSuccessResponse(res, status, data.data, headers);
      } catch (error) {
        // Check if we should retry and return error if not
        if (!this.retryStrategy.shouldRetry(error, attempt)) {
          return this.handleErrResponse(res, error);
        }

        // If we have maxed out our timeout, stop and throw an error instead.
        if (Date.now() - startTime >= this.totalTimeout) {
          throw new ApiGatewayError(
            504,
            "GATEWAY_TIMEOUT",
            "Request timed out",
          );
        }
      }

      attempt++;
      await this.retryStrategy.delay(attempt);
    }
  }

  async getServices(serviceType: string) {
    const { data } = await axios.get<ApiResponse<Instance[]>>(
      `/services/${serviceType}`,
      {
        baseURL: this.registryUrl,
        headers: this.registryHeaders,
      },
    );

    return data.data as Instance[];
  }

  handleSuccessResponse<T = any>(
    res: Response,
    status: number,
    data?: T,
    headers?: RawAxiosResponseHeaders | AxiosResponseHeaders,
  ) {
    const response: ApiResponse<T> = {
      success: true,
      timestamp: Date.now(),
      data,
    };

    res.set(filterResponseHeaders(headers));

    this.log.debug("Success Res - Status: ", status, "Res: ", response);
    res.status(status).json(response);
  }

  handleErrResponse(
    res: Response,
    err: AxiosError | ApiGatewayError | Error | unknown,
  ) {
    let status: number,
      data: any | undefined,
      code: string,
      message: string | undefined;

    if (err instanceof AxiosError) {
      // Error response originating from the called service
      if (err.response) {
        const { status: s, headers, data: resData } = err.response;
        status = s;

        if (headers) {
          res.set(headers);
        }

        // Copy over data and error from the response
        data = resData.data;

        if (resData.error && typeof resData.error === "string") {
          code = "SERVICE_ERROR";
          message = resData.error;
        } else if (resData.error) {
          const error = resData.error as ErrorResponse;
          code = error.code;
          message = error.message;
        } else {
          code = "SERVICE_ERROR";
          message = "Unknown error occured";
        }

        // Request was made but no response received
      } else if (err.request) {
        status = 502;
        code = "GATEWAY_ERROR";
        message = String(err.request);

        // Something happened when setting up the request that triggered an error
      } else {
        status = 500;
        code = "GATEWAY_ERROR";
        message = err.message;
      }
    } else if (err instanceof ApiGatewayError) {
      status = err.status;
      code = err.code;
      message = err.message;
      data = err.data;

      // Unhandled error occured
    } else {
      status = 500;
      code = "UNKNOWN_ERROR";
      message = err instanceof Error ? err.message : (err as any);
    }

    const response: ApiResponse = {
      success: false,
      timestamp: Date.now(),
      data,
      error: {
        code,
        message,
      },
    };

    this.log.error(
      "Err response - Status: ",
      status,
      "Code: ",
      code,
      "Message: ",
      message,
    );

    res.status(status).json(response);
  }

  /* HEALTH CHECKs */

  async checkRegistryHealth() {
    let attempts = 0;
    let url: string;

    try {
      url = new URL("/service", this.registryUrl).toString();
    } catch {
      throw new Error("Invalid registryUrl value: " + this.registryUrl);
    }

    this.log.debug("Attempting new health check for service registry");

    while (true) {
      try {
        const { data } = await axios.get<HealthCheckResponse>(url, {
          headers: this.registryHeaders,
          timeout: this.timeout,
        });

        this.log.debug(data);

        if (data.data?.status === "UP") {
          this.log.debug("Registry up");
          this.status = "GATEWAY_ACTIVE";
        } else {
          this.log.error("Registry down");
          this.status = "REGISTRY_HEALTH_CHECK_FAIL";
        }
      } catch (error) {
        this.log.error("Failed to confirm registry status");
        this.status = "REGISTRY_HEALTH_CHECK_FAIL";

        if (error instanceof AxiosError) {
          // Indicates the service registry no longer considers us authenticated so we must re-register
          if (error.response && error.response.status === 401) {
            this.log.warn(
              "Unauthenticated response from registry. Attempting re-registration...",
            );
            this.status = "ATTEMPTING_REREGISTRATION";

            // Timeout
          } else if (error.code === "ECONNABORTED") {
            this.log.warn("Connection timed out");

            // Unhandled
          } else {
            this.log.error(
              "Unhandled axios error Status - ",
              error.status,
              ", Code - ",
              error.code,
              ", Message - ",
              error.message,
            );
          }

          // Some other non-axios unhandled
        } else {
          this.log.error("Unhandled Health Check Error -", error);
        }
      } finally {
        // Everything's good, start healthcheck timer
        if (this.status === "GATEWAY_ACTIVE") {
          if (this.healthChecks) {
            this.healthCheckTimeout = setTimeout(
              () => this.checkRegistryHealth(),
              this.healthCheckInterval,
            );
          }
          break;

          // Registry responded but is down. Wait a short period and try again
        } else if (
          this.status === "REGISTRY_HEALTH_CHECK_FAIL" &&
          attempts < 3
        ) {
          await this.retryStrategy.delay(attempts);

          // We need to re-register with service registry
        } else if (this.status === "ATTEMPTING_REREGISTRATION") {
          return this.attemptReregister();

          // We've gone over our attempts
        } else if (attempts >= 3) {
          if (this.healthCheckFailStrategy === "shutdown") {
            this.status = "SHUTTING_DOWN";
            this.log.error(
              "Could not connect to service registry. Shutting down...",
            );
            process.emit("SIGTERM");
          } else {
            this.status = "REGISTRY_HEALTH_CHECK_FAIL";
            this.log.error(
              "Did not receive 'UP' status from registry after 3 attempts. Trying again later",
            );
            if (this.healthChecks) {
              this.healthCheckTimeout = setTimeout(
                () => this.checkRegistryHealth(),
                this.healthCheckInterval,
              );
            }
          }
          break;

          // Sanity check
        } else {
          throw new Error("unreachable");
        }

        attempts++;
      }
    }
  }

  private async attemptReregister() {
    let attempts = 0;

    while (true) {
      // Since we already registered successfully once, we should definitely have a port number and reg key
      const registered = await this.register(this.port as number);

      if (registered) {
        this.status = "GATEWAY_ACTIVE";
        return;
      }

      // Theoretically shouldn't happen since we already successfully registered once before
      if (attempts >= 3) {
        this.log.error(
          "FATAL ERROR: Could not re-register with service registry. Shutting down...",
        );
        this.status = "SHUTTING_DOWN";
        process.emit("SIGTERM");
        return;
      }

      attempts++;
      await this.retryStrategy.delay(attempts);
    }
  }
}

export default ApiGateway;
