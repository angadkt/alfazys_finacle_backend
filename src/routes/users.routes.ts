import { Router } from "express";
import { z } from "zod";
import { audit } from "../audit";
import { requireAuth, requireAdmin } from "../auth/middleware";
import { hashPassword } from "../auth/password";
import { MODULES } from "../auth/permissions";
import { pool, tx } from "../db";
import { HttpError } from "../errors";

const router = Router();
router.use(requireAuth, requireAdmin);

const idParam = z.object({ id: z.string().regex(/^\d+$/) });
const level = z.enum(["none", "view", "edit"]);
const permissionsSchema = z.object({ financial: level, flat: level, investment: level }).partial().strict();
const password = z.string().min(10, "Password must be at least 10 characters").max(200);

const USER_FIELDS = "id, full_name, email, role, is_active, created_at";

/**
 * @openapi
 * /users/staff:
 *   get:
 *     summary: Get all staff members
 *     tags: [Users]
 *     responses:
 *       200:
 *         description: List of staff members
 */
router.get("/staff", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.role, u.is_active, u.created_at,
            COALESCE(jsonb_object_agg(p.module, p.level) FILTER (WHERE p.module IS NOT NULL), '{}') AS permissions
     FROM users u LEFT JOIN user_permissions p ON p.user_id = u.id
     WHERE u.role = 'staff'
     GROUP BY u.id ORDER BY u.id`);
  res.json({ staff: rows });
});

router.get("/", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.role, u.is_active, u.created_at,
            COALESCE(jsonb_object_agg(p.module, p.level) FILTER (WHERE p.module IS NOT NULL), '{}') AS permissions
     FROM users u LEFT JOIN user_permissions p ON p.user_id = u.id
     GROUP BY u.id ORDER BY u.id`);
  res.json({ users: rows });
});

/**
 * @openapi
 * /users:
 *   post:
 *     summary: Create a new Staff user
 *     tags: [Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fullName
 *               - email
 *               - password
 *             properties:
 *               fullName:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *               role:
 *                 type: string
 *                 enum: [staff]
 *                 default: staff
 *               permissions:
 *                 type: object
 *                 properties:
 *                   financial:
 *                     type: string
 *                     enum: [none, view, edit]
 *                   flat:
 *                     type: string
 *                     enum: [none, view, edit]
 *                   investment:
 *                     type: string
 *                     enum: [none, view, edit]
 *     responses:
 *       201:
 *         description: User created successfully
 *       403:
 *         description: Forbidden (Only admins can create users)
 */
router.post("/", async (req, res) => {
  const body = z.object({
    fullName: z.string().trim().min(1).max(200),
    email: z.string().trim().toLowerCase().pipe(z.email()),
    password,
    role: z.literal("staff").default("staff"),
    permissions: permissionsSchema.optional(),
  }).parse(req.body);

  const user = await tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO users (full_name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING ${USER_FIELDS}`,
      [body.fullName, body.email, await hashPassword(body.password), body.role]);
    for (const m of MODULES) {
      await c.query("INSERT INTO user_permissions (user_id, module, level) VALUES ($1, $2, $3)",
        [rows[0].id, m, body.permissions?.[m] ?? "none"]);
    }
    await audit(c, { userId: req.user!.id, action: "create_user", table: "users", recordId: rows[0].id,
      newData: { email: body.email, role: body.role, permissions: body.permissions ?? {} }, ip: req.ip });
    return rows[0];
  });
  res.status(201).json({ user });
});

router.patch("/:id", async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = z.object({
    fullName: z.string().trim().min(1).max(200).optional(),
    isActive: z.boolean().optional(),
    role: z.enum(["admin", "staff", "agent"]).optional(),
  }).parse(req.body);

  if (id === req.user!.id && (body.isActive === false || body.role === "staff")) {
    throw new HttpError(400, "You cannot deactivate or demote your own account");
  }
  const { rows } = await pool.query(
    `UPDATE users SET full_name = COALESCE($2, full_name), is_active = COALESCE($3, is_active),
            role = COALESCE($4::user_role, role)
     WHERE id = $1 RETURNING ${USER_FIELDS}`,
    [id, body.fullName ?? null, body.isActive ?? null, body.role ?? null]);
  if (!rows[0]) throw new HttpError(404, "User not found");
  await audit(pool, { userId: req.user!.id, action: "update_user", table: "users", recordId: id, newData: body, ip: req.ip });
  res.json({ user: rows[0] });
});

router.put("/:id/permissions", async (req, res) => {
  const { id } = idParam.parse(req.params);
  const perms = permissionsSchema.parse(req.body);
  await tx(async (c) => {
    const exists = await c.query("SELECT 1 FROM users WHERE id = $1", [id]);
    if (!exists.rowCount) throw new HttpError(404, "User not found");
    for (const [module, lvl] of Object.entries(perms)) {
      await c.query(
        `INSERT INTO user_permissions (user_id, module, level) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, module) DO UPDATE SET level = EXCLUDED.level`, [id, module, lvl]);
    }
    await audit(c, { userId: req.user!.id, action: "set_permissions", table: "users", recordId: id, newData: perms, ip: req.ip });
  });
  res.json({ ok: true });
});

router.post("/:id/reset-password", async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { password: pw } = z.object({ password }).parse(req.body);
  const r = await pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [id, await hashPassword(pw)]);
  if (!r.rowCount) throw new HttpError(404, "User not found");
  await audit(pool, { userId: req.user!.id, action: "reset_password", table: "users", recordId: id, ip: req.ip });
  res.json({ ok: true });
});

export default router;
