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
const app = createApi(gateway);

const server = app.listen(port, async () => {
  logger.info(`Api Gateway listening on port ${port}`);

  // Will attempt to register 3 times with the service registry and shutdown otherwise
  let attempts = 0;

  while (true) {
    attempts++;

    try {
      const registered = await gateway.register(Number(port));

      if (registered) {
        break;
      }
    } catch (error) {
      // Only occurs when SERVICE_REGISTRY_KEY isn't set in which case we shutdown
      logger.error(error);
      return shutdown();
    }

    if (attempts >= 3) {
      logger.error(
        "Could not connect to the service registry after 3 attempts. Shutting down",
      );
      return shutdown();
    }
  }
});

const shutdown = () => {
  logger.debug("Closing server");
  server.close(() => {
    logger.debug("Api Gateway Closed");
  });
};

process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());
