import ApiGateway, { ApiGatewayError } from "@app/api-gateway";
import axios, { AxiosError } from "axios";
import { Request, Response } from "express";

jest.mock("axios");
const mockAxios = axios as jest.Mocked<typeof axios>;

const createError = (
  status: number,
  code: string,
  message?: string,
  data?: any,
) => {
  return new ApiGatewayError(status, code, message, data);
};

describe("Api Gateway", () => {
  let apiGateway: ApiGateway;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;

  beforeEach(() => {
    jest.clearAllMocks();

    // First request will always be to the registry
    mockAxios.post.mockResolvedValueOnce({
      data: {
        serviceId: "test-id",
        token: "test-token",
      },
    });

    mockReq = {
      method: "GET",
      headers: {},
      body: {},
    };

    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      set: jest.fn(),
    };

    process.env.SERVICE_REGISTRATION_KEY = "abc123";

    apiGateway = new ApiGateway({
      retryStrategy: { maxRetries: 0 },
      healthChecks: false,
    });
    return apiGateway.register(3001);
  });

  describe("init", () => {
    test("it needs a registration key", () => {
      process.env.SERVICE_REGISTRATION_KEY = "";

      expect(async () => {
        const gate = new ApiGateway();
        await gate.register(3001);
      }).rejects.toThrow();
    });
  });

  describe("handleServiceRequest", () => {
    test("it should retry failed requests according to strategy", async () => {
      apiGateway.retryStrategy.maxRetries = 3;
      apiGateway.retryStrategy.maxDelay = 5;
      mockAxios.get.mockResolvedValueOnce({
        data: {
          success: true,
          data: [
            {
              id: "1",
              host: "localhost",
              port: 3001,
              status: "active",
            },
          ],
        },
      });

      // Mock service failing twice then succeeding
      mockAxios.request
        .mockRejectedValueOnce(new ApiGatewayError(500, "Network error"))
        .mockRejectedValueOnce(new ApiGatewayError(502, "Network error"))
        .mockResolvedValueOnce({
          data: { success: true, data: { message: "Success" } },
          status: 200,
          headers: {},
        });

      await apiGateway.handleRequest(
        mockReq as Request,
        mockRes as Response,
        "test-service",
        "api/endpoint",
      );

      expect(mockAxios.request).toHaveBeenCalledTimes(3);
      expect(mockRes.status).toHaveBeenCalledWith(200);
    });
  });

  describe("handleRequests", () => {
    test("it successfully proxys a request to a service", async () => {
      // Mock getting service instances
      mockAxios.get.mockResolvedValueOnce({
        data: {
          success: true,
          data: [
            {
              id: "1",
              host: "localhost",
              port: 3001,
              status: "active",
            },
          ],
        },
      });

      // Mock the service response
      mockAxios.request.mockResolvedValueOnce({
        data: { success: true, data: { message: "Success" } },
        status: 200,
        headers: { "content-type": "application/json" },
      });

      await apiGateway.handleRequest(
        mockReq as Request,
        mockRes as Response,
        "test-service",
        "api/endpoint",
      );

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        timestamp: expect.any(Number),
        data: { message: "Success" },
      });
    });

    test("it should handle service errors appropriately", async () => {
      // Mock getting service instances
      mockAxios.get.mockResolvedValueOnce({
        data: {
          success: true,
          data: [
            {
              id: "1",
              host: "localhost",
              port: 3001,
              status: "active",
            },
          ],
        },
      });

      // Mock service error response
      mockAxios.request.mockRejectedValueOnce(
        createError(400, "VALIDATION_ERROR", "Invalid input"),
      );

      await apiGateway.handleRequest(
        mockReq as Request,
        mockRes as Response,
        "test-service",
        "api/endpoint",
      );

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        timestamp: expect.any(Number),
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid input",
        },
      });
    });

    test("it should handle gateway not ready", async () => {
      const newGateway = new ApiGateway();

      await newGateway.handleRequest(
        mockReq as Request,
        mockRes as Response,
        "test-service",
        "api/endpoint",
      );

      expect(mockRes.status).toHaveBeenCalledWith(503);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        timestamp: expect.any(Number),
        error: {
          code: "GATEWAY_STARTING",
          message: "Gateway is starting. Please try again shortly",
        },
      });
    });
  });
});

describe("Health Checks", () => {
  let apiGateway: ApiGateway;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  const processEmit = global.process.emit;

  beforeEach(() => {
    jest.clearAllMocks();

    // First request will always be to the registry
    mockAxios.post.mockResolvedValueOnce({
      data: {
        serviceId: "test-id",
        token: "test-token",
      },
    });

    mockReq = {
      method: "GET",
      headers: {},
      body: {},
    };

    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      set: jest.fn(),
    };

    process.env.SERVICE_REGISTRATION_KEY = "abc123";
    global.process.emit = jest.fn();

    apiGateway = new ApiGateway({
      retryStrategy: { baseDelay: 1 },
      healthChecks: false,
    });

    return apiGateway.register(3001);
  });

  afterEach(() => {
    global.process.emit = processEmit;
    clearTimeout(apiGateway.healthCheckTimeout);
  });

  test("it periodically checks health", async () => {
    apiGateway.healthChecks = true;
    apiGateway.healthCheckInterval = 1;
    mockAxios.get.mockResolvedValue({
      data: {
        success: true,
        data: { status: "UP" },
      },
    });

    await apiGateway.checkRegistryHealth();

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    }).then(() => {
      apiGateway.healthChecks = false;
      clearTimeout(apiGateway.healthCheckTimeout);
      expect(mockAxios.get.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  test("it retries on failure", async () => {
    for (let i = 0; i < 3; i++) {
      mockAxios.get.mockResolvedValueOnce({
        data: {
          success: true,
          data: { status: i == 2 ? "UP" : "DOWN" },
        },
      });
    }

    await apiGateway.checkRegistryHealth();

    expect(mockAxios.get).toHaveBeenCalledTimes(3);
    expect(apiGateway.status).toBe("GATEWAY_ACTIVE");
  });

  test("it adheres to strategy after 3 attempts", async () => {
    mockAxios.get.mockResolvedValue({
      data: {
        success: true,
        data: { status: "DOWN" },
      },
    });

    await apiGateway.checkRegistryHealth();
    expect(apiGateway.status).toBe("REGISTRY_HEALTH_CHECK_FAIL");

    apiGateway.healthCheckFailStrategy = "shutdown";
    await apiGateway.checkRegistryHealth();
    expect(apiGateway.status).toBe("SHUTTING_DOWN");
    expect(global.process.emit).toHaveBeenCalledWith("SIGTERM");
  });

  test("it attempts to re-register if authentication is lost", async () => {
    const error = new AxiosError();
    // @ts-ignore
    error.response = {
      status: 401,
    };
    mockAxios.get.mockRejectedValueOnce(error);
    // @ts-ignore
    apiGateway.attemptReregister = jest.fn();

    await apiGateway.checkRegistryHealth();
    expect(apiGateway.status).toBe("ATTEMPTING_REREGISTRATION");
    // @ts-ignore
    expect(apiGateway.attemptReregister).toHaveBeenCalled();
  });
});
