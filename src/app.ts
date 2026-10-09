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

app.use(helmet());
app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));
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
