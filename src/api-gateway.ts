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
  registryUrl?: string | URL;
  loadBalancerStrategy?: "round-robin" | "random";
  logger?: Logger;
  retryStrategy?: RetryStrategyOptions;
}

type Headers = { [key: string]: string | string[] | undefined };

const EXCLUDED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "authorization", // if you handle auth at the gateway level
]);

/**
 * Fitlers out headers that we don't want to pass to the requested service
 * @param headers
 */
const filterHeaders = (headers?: IncomingHttpHeaders) => {
  const filtered: Headers = {};
  Object.entries(headers ?? {}).forEach(([k, v]) => {
    if (!EXCLUDED_HEADERS.has(k.toLowerCase())) {
      filtered[k] = v;
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
}

class ApiGateway {
  private registryUrl: string;
  private isReady = false;

  timeout: number;
  totalTimeout: number;
  retryStrategy: RetryStrategy;
  client: AxiosStatic = axios;
  registryHeaders: RegistryHeaders | undefined;
  log: Logger;
  loadBalancer: RoundRobinBalancer | RandomBalancer;

  constructor(opts?: ApiGatewayOpts) {
    this.registryUrl =
      String(opts?.registryUrl) ??
      process.env.REGISTRY_URL ??
      "http://localhost:3002";
    this.log = opts?.logger ?? console;
    this.timeout = opts?.requestTimeout ?? 5000;
    this.totalTimeout = opts?.totalRequestTimeout ?? 10000;

    switch (opts?.loadBalancerStrategy ?? "random") {
      case "round-robin":
        this.loadBalancer = new RoundRobinBalancer();
        break;
      default:
        this.loadBalancer = new RandomBalancer();
        break;
    }

    this.retryStrategy = new RetryStrategy(opts?.retryStrategy);

    this.log.info("Starting api gateway");
  }

  async register(port: number) {
    if (!process.env.SERVICE_REGISTRATION_KEY) {
      throw new Error("SERVICE_REGISTRATION_KEY is required to be set");
    }

    this.log.debug("Obtaining initial registration");

    const url = new URL("/service", this.registryUrl);

    try {
      const { data } = await axios.post<RegistrationResponse>(
        url.toString(),
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

      this.isReady = true;
      this.registryHeaders = {
        "x-service-id": serviceId,
        "x-service-token": token,
      };

      this.log.debug("Api Gateway Registered");
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
      // Gateway hasn't finished registering yet
      if (!this.isReady) {
        throw new ApiGatewayError(
          503,
          "GATEWAY_STARTING",
          "Gateway is starting. Please try again shortly",
        );
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
    const filteredHeaders = filterHeaders(req.headers);

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
    headers?: any,
  ) {
    const response: ApiResponse<T> = {
      success: true,
      timestamp: Date.now(),
      data,
    };

    res.set(headers);

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
}

export default ApiGateway;
