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

export const app = express();

app.use(helmet());
app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.get("/health", (_req, res) => res.json({ ok: true }));

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
