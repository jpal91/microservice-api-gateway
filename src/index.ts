import createApi from "./api";
import ApiGateway from "./api-gateway";
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino-pretty",
  },
});

const port = process.env.PORT || 3001;
const gateway = new ApiGateway({ logger });
gateway.register(Number(port));
const app = createApi(gateway);

const server = app.listen(port, () => {
  logger.info(`Api Gateway listening on port ${port}`);
});

const shutdown = () => {
  logger.debug("Closing server");
  server.close(() => {
    logger.debug("Api Gateway Closed");
  });
};

process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());
