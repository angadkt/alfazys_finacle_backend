import type { NextFunction, Request, Response } from "express";

/**
 * Simple request logger for production monitoring.
 * Logs: method, path, status, duration.
 * NEVER logs: passwords, tokens, cookies, financial data, personal info.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();

  res.on("finish", () => {
    const ms = Date.now() - start;
    const line = `${req.method} ${req.path} ${res.statusCode} ${ms}ms`;

    if (res.statusCode >= 500) {
      console.error(`[ERROR] ${line}`);
    } else if (res.statusCode >= 400) {
      console.warn(`[WARN]  ${line}`);
    } else {
      console.log(`[REQ]   ${line}`);
    }
  });

  next();
}
