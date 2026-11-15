import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { audit } from "../audit";
import { requireAuth } from "../auth/middleware";
import { hashPassword, verifyPassword } from "../auth/password";
import { signToken } from "../auth/token";
import { config } from "../config";
import { pool } from "../db";
import { HttpError } from "../errors";

const router = Router();

// Used so a wrong email takes the same time as a wrong password.
const dummyHash = hashPassword("not-a-real-password-for-timing");

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again in 15 minutes" },
});

const loginSchema = z.object({
  email: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(200),
});

const passwordSchema = z.string().min(8, "Password must be at least 8 characters").max(200);

/**
 * @openapi
 * /auth/login:
 *   post:
 *     summary: Authenticate user
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *                 example: sarah.alfayed@finacle.io
 *               password:
 *                 type: string
 *                 example: admin
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 *       429:
 *         description: Too many login attempts
 */
router.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const identifier = email.trim();
  const { rows } = await pool.query(
    `SELECT id, full_name, show_name, designation, staff_code, username, email, role, is_active, password_hash 
     FROM users 
     WHERE LOWER(email) = LOWER($1) 
        OR LOWER(COALESCE(staff_code, '')) = LOWER($1) 
        OR LOWER(COALESCE(username, '')) = LOWER($1)`,
    [identifier]
  );
  const user = rows[0];

  const ok = await verifyPassword(user?.password_hash ?? (await dummyHash), password);
  if (!user || !user.is_active || !ok) {
    await audit(pool, { userId: user ? String(user.id) : null, action: "login_failed", newData: { email: identifier }, ip: req.ip });
    throw new HttpError(401, "Wrong email or password");
  }

  const token = signToken(String(user.id));

  res.cookie("token", token, {
    httpOnly: true,
    // Cross-origin: "none" in production (requires secure: true).
    // In local development, "lax" allows cross-port local testing.
    sameSite: config.NODE_ENV === "production" ? "none" : "lax",
    secure: config.NODE_ENV === "production",
    maxAge: config.SESSION_HOURS * 3600 * 1000,
  });
  await audit(pool, { userId: String(user.id), action: "login", ip: req.ip });
  res.json({
    token,
    user: {
      id: String(user.id),
      fullName: user.full_name,
      showName: user.show_name,
      designation: user.designation,
      staffCode: user.staff_code,
      username: user.username,
      email: user.email,
      role: user.role
    },
  });
});

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     summary: Logout user
 *     tags: [Authentication]
 *     responses:
 *       200:
 *         description: Logout successful
 */
router.post("/logout", (_req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

/**
 * @openapi
 * /auth/me:
 *   get:
 *     summary: Check current session
 *     tags: [Authentication]
 *     responses:
 *       200:
 *         description: Session valid
 *       401:
 *         description: Unauthorized
 */
router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});


/**
 * @openapi
 * /auth/change-password:
 *   post:
 *     summary: Change user password
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               currentPassword:
 *                 type: string
 *               newPassword:
 *                 type: string
 *                 description: Must be at least 10 characters
 *     responses:
 *       200:
 *         description: Password successfully changed
 *       400:
 *         description: Current password is wrong or new password is too short
 *       401:
 *         description: Unauthorized (Must be logged in)
 */
router.post("/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = z
    .object({ currentPassword: z.string().min(1), newPassword: passwordSchema })
    .parse(req.body);
  const { rows } = await pool.query("SELECT password_hash FROM users WHERE id = $1", [req.user!.id]);
  if (!(await verifyPassword(rows[0].password_hash, currentPassword))) throw new HttpError(400, "Current password is wrong");
  await pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [req.user!.id, await hashPassword(newPassword)]);
  await audit(pool, { userId: req.user!.id, action: "change_password", ip: req.ip });
  res.json({ ok: true });
});


/**
 * @openapi
 * /auth/first-login-change-password:
 *   post:
 *     summary: Update password on mandatory first login using temporary password
 *     tags: [Authentication]
 */
router.post("/first-login-change-password", async (req, res) => {
  const { credential, currentPassword, newPassword } = z
    .object({
      credential: z.string().trim().min(1).max(200),
      currentPassword: z.string().min(1).max(200),
      newPassword: passwordSchema,
    })
    .parse(req.body);

  const identifier = credential.trim();
  const { rows } = await pool.query(
    `SELECT id, full_name, email, role, is_active, password_hash 
     FROM users 
     WHERE LOWER(email) = LOWER($1) 
        OR LOWER(COALESCE(staff_code, '')) = LOWER($1) 
        OR LOWER(COALESCE(username, '')) = LOWER($1)`,
    [identifier]
  );
  const user = rows[0];
  if (!user || !user.is_active) {
    throw new HttpError(404, "User account not found or deactivated");
  }

  const ok = await verifyPassword(user.password_hash, currentPassword);
  if (!ok) {
    throw new HttpError(400, "Current temporary password is wrong");
  }

  const newHash = await hashPassword(newPassword);
  await pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [user.id, newHash]);
  await audit(pool, { userId: String(user.id), action: "first_login_change_password", ip: req.ip });

  const token = signToken(String(user.id));
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: config.NODE_ENV === "production" ? "none" : "lax",
    secure: config.NODE_ENV === "production",
    maxAge: config.SESSION_HOURS * 3600 * 1000,
  });

  res.json({
    ok: true,
    token,
    user: { id: String(user.id), fullName: user.full_name, email: user.email, role: user.role }
  });
});

export default router;
