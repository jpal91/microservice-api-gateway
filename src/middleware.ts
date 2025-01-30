import express from "express";
import morgan from "morgan";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";

export default [
  express.json(),
  express.urlencoded({ extended: true }),
  morgan("combined"),

  helmet({
    contentSecurityPolicy: false,

    // Hanlded by cors
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,

    hsts: {
      maxAge: 15552000,
      includeSubDomains: true,
      preload: true,
    },
    hidePoweredBy: true,
    frameguard: {
      action: "deny",
    },
    noSniff: true,
    xssFilter: true,
    dnsPrefetchControl: {
      allow: false,
    },
  }),

  cors({
    origin: [process.env.DOMAIN ?? "*"],
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
    exposedHeaders: ["Content-Range", "X-Content-Range"],
    credentials: true,
    maxAge: 86400,
  }),

  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: {
      success: false,
      timestamp: Date.now(),
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests, try again later",
      },
    },
  }),
];
