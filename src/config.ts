import "dotenv/config";
import { z } from "zod";

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: isTest
    ? z.string().min(1).default("postgresql://test:test@localhost:5432/test")
    : z.string().min(1),
  JWT_SECRET: isTest
    ? z.string().min(32).default("test-jwt-secret-key-at-least-32-characters-long")
    : z.string().min(32, "JWT_SECRET must be at least 32 characters"),
  SESSION_HOURS: z.coerce.number().int().positive().default(8),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  UPLOAD_DIR: z.string().default("./uploads"),
  DOC_ENCRYPTION_KEY: z.string().default("default-secret-key-please-change-it"),
});

export const config = schema.parse(process.env);

// Warn if DOC_ENCRYPTION_KEY is left at the insecure default in production.
// Does not crash — keeps the trial functional, but makes the risk visible.
if (config.NODE_ENV === "production" && config.DOC_ENCRYPTION_KEY === "default-secret-key-please-change-it") {
  console.warn("⚠️  WARNING: DOC_ENCRYPTION_KEY is using the default value. Set a proper 32-char or 64-hex key for production.");
}
