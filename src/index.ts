import express, { type Request, type Response } from "express";
import middleware from "./middleware";
import ApiGateway from "./api-gateway";
import type { ApiResponse } from "microservice-ecommerce";

const SERVICES = ["products", "orders", "cart", "users"];

const port = process.env.PORT || 3001;
const app = express();
const router = express.Router();

app.use(router);
app.use(...middleware);

const gateway = new ApiGateway(port);

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

app.listen(port, async () => {
  console.info("Api Gateway listening on", port);
});
