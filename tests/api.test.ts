import axios from "axios";
import type { Express, Request, Response } from "express";
import request from "supertest";
import createApi, { SERVICES } from "@app/api";
import ApiGateway, { ApiGatewayError } from "@app/api-gateway";

jest.mock("axios");
const mockAxios = axios as jest.Mocked<typeof axios>;

const genericInstanceResponse = {
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
};

const genericSuccess = {
  status: 200,
  data: {
    success: true,
    timestamp: 1,
    data: { message: "success" },
  },
};

describe("routes", () => {
  let app: Express;
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
    return apiGateway.register(3001).then(() => {
      app = createApi(apiGateway);
    });
  });

  test("it only accepts known services", async () => {
    await request(app).get("/nothing").expect(404);
    await request(app).get("/no-exist/something-else").expect(404);
  });

  test("it returns the proxied response", async () => {
    const success = {
      ...genericSuccess,
      headers: {
        "x-test-key": "1234",
        "keep-alive": "timeout=5, max=200",
      },
    };

    mockAxios.get.mockResolvedValueOnce(genericInstanceResponse);
    mockAxios.request.mockResolvedValueOnce(success);

    await request(app)
      .get("/products/all")
      .expect(200)
      .then((res) => {
        expect(res.body.success).toBe(true);
        expect(res.body.data.message).toBe("success");
        expect(res.headers["x-test-key"]).toBe("1234");
        expect(res.headers["keep-alive"]).toBeUndefined();
      });

    mockAxios.get.mockResolvedValueOnce(genericInstanceResponse);
    mockAxios.request.mockRejectedValueOnce(
      new ApiGatewayError(404, "NOT_FOUND"),
    );

    await request(app)
      .get("/products/all")
      .expect(404)
      .then((res) => {
        expect(res.body.success).toBe(false);
        expect(res.body.error.code).toBe("NOT_FOUND");
      });
  });

  test("it accepts all known services with any parameters", async () => {
    for (const service of SERVICES) {
      for (const method of ["get", "post", "patch", "put", "delete"]) {
        mockAxios.get.mockResolvedValueOnce(genericInstanceResponse);
        mockAxios.get.mockResolvedValueOnce(genericInstanceResponse);
        mockAxios.request.mockResolvedValueOnce(genericSuccess);
        mockAxios.request.mockResolvedValueOnce(genericSuccess);

        //@ts-ignore
        await request(app)[method](`/${service}/`).expect(200);
        //@ts-ignore
        await request(app)[method](`/${service}/ids?first=true`).expect(200);
      }
    }
  });
});
