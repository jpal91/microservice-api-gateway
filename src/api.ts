import express, { type Request, type Response } from "express";
import middleware from "./middleware";
import type ApiGateway from "./api-gateway";
import type { ApiResponse } from "microservice-ecommerce";

export const SERVICES = ["products", "orders", "cart", "users"];

const createApi = (gateway: ApiGateway) => {
  const app = express();
  const router = express.Router();

  app.use(router);
  app.use(...middleware);

  SERVICES.forEach((service) => {
    router.all(`/${service}/*`, async (req: Request, res: Response) => {
      const rest = req.params[0] ?? "";
      await gateway.handleRequest(req, res, service, rest);
    });
  });

  router.all("/*", (req: Request, res: Response) => {
    const response: ApiResponse = {
      success: false,
      timestamp: Date.now(),
      error: {
        code: "SERVICE_NO_EXIST",
      },
    };

    res.status(404).json(response);
  });

  return app;
};

export default createApi;
