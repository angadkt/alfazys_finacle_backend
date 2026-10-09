import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { config } from "./config";
import { errorHandler } from "./errors";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./swagger";
import approvals from "./routes/approvals.routes";
import auth from "./routes/auth.routes";
import records from "./routes/records.routes";
import users from "./routes/users.routes";
import masters from "./routes/masters.routes";
import cif from "./routes/cif.routes";

import { pool } from "./db";
import { requestLogger } from "./logger";

export const app = express();

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

// Allowed origins for CORS (supports local development, Vercel frontend, and env overrides)
const allowedOrigins = [
  "https://alfazys-finacle.vercel.app",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:4173",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
];

const customOrigins = config.CORS_ORIGIN
  ? config.CORS_ORIGIN.split(",").map((o) => o.trim())
  : [];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like Postman, mobile apps, curl)
      if (!origin) return callback(null, true);

      // Check configured origins
      if (allowedOrigins.includes(origin) || customOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Allow any Vercel preview deployment (*.vercel.app)
      if (/^https:\/\/[a-zA-Z0-9_.-]+\.vercel\.app$/.test(origin)) {
        return callback(null, true);
      }

      // Allow any localhost / 127.0.0.1 port (for local dev testing)
      if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return callback(null, true);
      }

      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Cookie", "X-Requested-With", "Accept"],
    exposedHeaders: ["Set-Cookie"],
  }),
);

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(requestLogger);

// Health check — verifies database connectivity.
// Does NOT expose credentials, version numbers, or financial data.
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// Swagger UI Route
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.use("/auth", auth);
app.use("/users", users);
app.use("/records", records);
app.use("/masters", masters);
app.use("/cif", cif);
app.use("/approvals", approvals);

app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use(errorHandler);
