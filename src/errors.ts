import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Invalid input",
      details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
    return;
  }
  const code = err?.code as string | undefined; // PostgreSQL error codes
  if (code === "23505") { res.status(409).json({ error: "This value already exists", detail: err.detail }); return; }
  if (code === "23503") { res.status(400).json({ error: "Linked record not found, or it is still in use", detail: err.detail }); return; }
  if (code === "23514" || code === "23502" || code === "22P02" || code === "22003") {
    res.status(400).json({ error: "Data is not valid", detail: err.detail ?? err.message });
    return;
  }
  if (code === "P0001") { res.status(409).json({ error: err.message }); return; } // raised by our trigger
  console.error(err);
  res.status(500).json({ error: "Something went wrong", message: err.message, stack: err.stack });
};
