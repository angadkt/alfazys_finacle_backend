import type { NextFunction, Request, Response } from "express";
import { pool } from "../db";
import { HttpError } from "../errors";
import { AuthUser, Level, MODULES, Module, hasAccess } from "./permissions";
import { verifyToken } from "./token";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/**
 * Reads the login cookie, then loads the user and permissions from the database
 * on every request. So when the admin changes a permission or deactivates a user,
 * it works immediately.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  const token = (req.cookies?.token as string | undefined) || bearerToken;
  if (!token) throw new HttpError(401, "Please log in");

  let userId: string;
  try {
    userId = verifyToken(token).userId;
  } catch {
    throw new HttpError(401, "Session expired. Please log in again");
  }

  const u = await pool.query(
    "SELECT id, full_name, email, role, is_active FROM users WHERE id = $1",
    [userId],
  );
  const row = u.rows[0];
  if (!row || !row.is_active) throw new HttpError(401, "Account is not active");

  const perms: Record<Module, Level> = { financial: "none", flat: "none", investment: "none" };
  const p = await pool.query("SELECT module, level FROM user_permissions WHERE user_id = $1", [userId]);
  for (const r of p.rows) if (MODULES.includes(r.module)) perms[r.module as Module] = r.level;

  req.user = { id: String(row.id), fullName: row.full_name, email: row.email, role: row.role, permissions: perms };
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") throw new HttpError(403, "Only the admin can do this");
  next();
}

export const requireModule = (module: Module, need: Level) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !hasAccess(req.user, module, need)) throw new HttpError(403, "You do not have access to this module");
    next();
  };
