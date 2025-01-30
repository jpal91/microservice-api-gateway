import axios, {
  type AxiosStatic,
  AxiosError,
  type AxiosResponseHeaders,
  type RawAxiosResponseHeaders,
} from "axios";
import { RawAxiosRequestHeaders } from "axios";
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
  registryUrl?: string | URL;
  loadBalancerStrategy?: "round-robin" | "random" | "least-connections";
  logger?: Logger;
  retryStrategy?: RetryStrategyOptions;
}

type Headers = { [key: string]: string };

class ApiGatewayError extends Error {
  status: number;
  code: ErrorCodes;

  constructor(status: number, code: ErrorCodes, message?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class ApiGateway {
  private registryUrl: string;
  private isReady = false;

  retryStrategy: RetryStrategy;
  client: AxiosStatic = axios;
  registryHeaders: RegistryHeaders | undefined;
  log: Logger;
  lbStrategy: ApiGatewayOpts["loadBalancerStrategy"];

  constructor(port: number, opts?: ApiGatewayOpts) {
    this.registryUrl =
      String(opts?.registryUrl) ??
      process.env.REGISTRY_URL ??
      "http://localhost:3002";
    this.lbStrategy = opts?.loadBalancerStrategy ?? "round-robin";
    this.log = opts?.logger ?? console;

    this.retryStrategy = new RetryStrategy(opts?.retryStrategy);

    this.register(port);
    this.log.info("Starting api gateway");
  }

  async register(port: number) {
    if (!process.env.SERVICE_REGISTRATION_KEY) {
      throw new Error("SERVICE_REGISTRATION_KEY is required to be set");
    }

    this.log.debug("Obtaining initial registration");
    const { data } = await axios.post<RegistrationResponse>(
      "/service",
      {
        port,
        serviceType: "api-gateway",
      },
      {
        baseURL: this.registryUrl,
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
  }

  async handleRequest(req: Request, res: Response) {
    try {
      // Gateway hasn't finished registering yet
      if (!this.isReady) {
        throw new ApiGatewayError(
          503,
          "GATEWAY_STARTING",
          "Gateway is starting. Please try again shortly",
        );
      }

      // First part of the path should indicate the service name requested
      const [serviceName, ...remaining] = req.path.split("/").filter(Boolean);
      const instances = await this.getServices(serviceName);

      // TODO: load balancer
      const service = instances[0];
      const targetUrl = `https://${service.host}:${service.port}/${remaining.join("/")}`;

      this.log.debug(
        "Service request - Name: ",
        serviceName,
        "Resolved url: ",
        targetUrl,
      );

      const { data, status, headers } = await axios.request<ApiResponse>({
        method: req.method,
        url: targetUrl,
        headers: req.headers,
        data: req.body,
      });

      this.handleSuccessResponse(res, status, data, headers);
    } catch (e) {
      this.handleErrResponse(res, e);
    }
  }

  async handleServiceRequest(req: Request, res: Response, url: string) {
    let attempt = 0;

    // Attempts to fufill the request using the configured retry strategy
    while (true) {
      try {
        const { data, status, headers } = await axios.request<ApiResponse>({
          method: req.method,
          url,
          headers: req.headers,
          data: req.body,
        });

        return this.handleSuccessResponse(res, status, data, headers);
      } catch (error) {
        if (!this.retryStrategy.shouldRetry(error, attempt)) {
          return this.handleErrResponse(res, error);
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

      // Unhandled error occured
    } else {
      status = 500;
      code = "UNKNOWN_ERROR";
      message = err instanceof Error ? err.message : String(err);
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
