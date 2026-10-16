import { sendStaffCredentialsEmail } from "../services/mailer";
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
const password = z.string().min(6, "Password must be at least 6 characters").max(200);

const USER_FIELDS = "id, full_name, email, role, is_active, created_at";

/**
 * @openapi
 * /users/staff:
 *   get:
 *     summary: Get all staff members
 */
router.get("/staff", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.role, u.is_active, u.created_at,
            COALESCE(jsonb_object_agg(p.module, p.level) FILTER (WHERE p.module IS NOT NULL), '{}') AS permissions
     FROM users u LEFT JOIN user_permissions p ON p.user_id = u.id
     WHERE u.role = 'staff'
     GROUP BY u.id ORDER BY u.id`
  );
  res.json({ staff: rows });
});

router.get("/mailer/status", async (_req, res) => {
  const host = process.env.SMTP_HOST || process.env.EMAIL_HOST || "smtp.gmail.com";
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const rawPass = process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.SMTP_PASSWORD;
  const hasPass = Boolean(rawPass && rawPass.trim());
  res.json({
    smtpConfigured: Boolean(user && hasPass),
    host,
    user: user ? `${user.substring(0, 3)}***@${user.split('@')[1] || 'domain'}` : null,
    hasPassword: hasPass
  });
});

router.get("/", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, u.email, u.role, u.is_active, u.created_at,
            COALESCE(jsonb_object_agg(p.module, p.level) FILTER (WHERE p.module IS NOT NULL), '{}') AS permissions
     FROM users u LEFT JOIN user_permissions p ON p.user_id = u.id
     GROUP BY u.id ORDER BY u.id`
  );
  res.json({ users: rows });
});

/**
 * @openapi
 * /users:
 *   post:
 *     summary: Create or re-provision a Staff user and dispatch credentials via SMTP
 */
router.post("/", async (req, res) => {
  const body = z.object({
    fullName: z.string().trim().min(1).max(200),
    email: z.string().trim().toLowerCase().pipe(z.email()),
    password,
    role: z.literal("staff").default("staff"),
    permissions: permissionsSchema.optional(),
    sendEmail: z.boolean().optional().default(true),
  }).parse(req.body);

  const existing = await pool.query(
    "SELECT id, role, is_active FROM users WHERE email = $1",
    [body.email]
  );

  let user: any;
  if (existing.rows[0]) {
    const existingUser = existing.rows[0];
    if (existingUser.role !== "staff") {
      throw new HttpError(400, "An account with this email exists with role: " + existingUser.role);
    }
    // Update existing staff member with new credentials and activate
    user = await tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE users SET full_name = $2, password_hash = $3, is_active = true, role = 'staff'
         WHERE id = $1 RETURNING ${USER_FIELDS}`,
        [existingUser.id, body.fullName, await hashPassword(body.password)]
      );
      for (const m of MODULES) {
        await c.query(
          `INSERT INTO user_permissions (user_id, module, level) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, module) DO UPDATE SET level = EXCLUDED.level`,
          [existingUser.id, m, body.permissions?.[m] ?? "none"]
        );
      }
      await audit(c, {
        userId: req.user!.id,
        action: "reprovision_user",
        table: "users",
        recordId: existingUser.id,
        newData: { email: body.email, role: body.role, permissions: body.permissions ?? {} },
        ip: req.ip
      });
      return rows[0];
    });
  } else {
    // Insert new staff member
    user = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO users (full_name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING ${USER_FIELDS}`,
        [body.fullName, body.email, await hashPassword(body.password), body.role]
      );
      for (const m of MODULES) {
        await c.query(
          "INSERT INTO user_permissions (user_id, module, level) VALUES ($1, $2, $3)",
          [rows[0].id, m, body.permissions?.[m] ?? "none"]
        );
      }
      await audit(c, {
        userId: req.user!.id,
        action: "create_user",
        table: "users",
        recordId: rows[0].id,
        newData: { email: body.email, role: body.role, permissions: body.permissions ?? {} },
        ip: req.ip
      });
      return rows[0];
    });
  }

  let mailResult = null;
  let emailDispatched = false;

  if (body.sendEmail) {
    emailDispatched = true;
    mailResult = { success: true, message: "Staff credentials email dispatch initiated." };
    // Non-blocking asynchronous dispatch
    sendStaffCredentialsEmail({
      to: body.email,
      staffId: (req.body?.staffCode || `STF-${user.id}`),
      fullName: (req.body?.fullName || body.fullName),
      staffCode: req.body?.staffCode,
      loginUsername: (req.body?.username || body.email.split('@')[0]),
      temporaryPassword: body.password
    }).then(res => {
      console.log(`[ASYNC EMAIL RESULT for ${body.email}]:`, res);
    }).catch(err => {
      console.error(`[ASYNC EMAIL ERROR for ${body.email}]:`, err?.message || err);
    });
  }

  res.status(201).json({ user, emailDispatched, mailResult });
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
    [id, body.fullName ?? null, body.isActive ?? null, body.role ?? null]
  );
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
         ON CONFLICT (user_id, module) DO UPDATE SET level = EXCLUDED.level`,
        [id, module, lvl]
      );
    }
    await audit(c, { userId: req.user!.id, action: "set_permissions", table: "users", recordId: id, newData: perms, ip: req.ip });
  });
  res.json({ ok: true });
});

router.delete("/by-email/:email", async (req, res) => {
  const email = req.params.email.toLowerCase().trim();
  const u = await pool.query("SELECT id, role FROM users WHERE email = $1", [email]);
  if (!u.rowCount) {
    return res.json({ ok: true, message: "User not found (already deleted)" });
  }
  const id = String(u.rows[0].id);
  if (id === req.user!.id) {
    throw new HttpError(400, "You cannot delete your own account");
  }

  try {
    await tx(async (c) => {
      await c.query("DELETE FROM user_permissions WHERE user_id = $1", [id]);
      await c.query("DELETE FROM users WHERE id = $1", [id]);
      await audit(c, { userId: req.user!.id, action: "delete_user", table: "users", recordId: id, ip: req.ip });
    });
    res.json({ ok: true, deleted: true });
  } catch {
    await pool.query("UPDATE users SET is_active = false WHERE id = $1", [id]);
    res.json({ ok: true, deactivated: true });
  }
});

router.delete("/:id", async (req, res) => {
  const { id } = idParam.parse(req.params);
  if (id === req.user!.id) {
    throw new HttpError(400, "You cannot delete your own account");
  }

  try {
    await tx(async (c) => {
      await c.query("DELETE FROM user_permissions WHERE user_id = $1", [id]);
      await c.query("DELETE FROM users WHERE id = $1", [id]);
      await audit(c, { userId: req.user!.id, action: "delete_user", table: "users", recordId: id, ip: req.ip });
    });
    res.json({ ok: true, deleted: true });
  } catch {
    await pool.query("UPDATE users SET is_active = false WHERE id = $1", [id]);
    res.json({ ok: true, deactivated: true });
  }
});

router.post("/:id/reset-password", async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { password: pw, sendEmail: shouldSend } = z.object({ 
    password,
    sendEmail: z.boolean().optional().default(true)
  }).parse(req.body);

  const r = await pool.query(
    "UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id, email, full_name",
    [id, await hashPassword(pw)]
  );
  if (!r.rowCount) throw new HttpError(404, "User not found");
  const targetUser = r.rows[0];
  await audit(pool, { userId: req.user!.id, action: "reset_password", table: "users", recordId: id, ip: req.ip });

  let mailResult = null;
  let emailDispatched = false;
  if (shouldSend) {
    emailDispatched = true;
    mailResult = { success: true, message: "Password reset email dispatch initiated." };
    sendStaffCredentialsEmail({
    to: targetUser.email,
    staffId: (req.body?.staffCode || `STF-${targetUser.id}`),
    fullName: (req.body?.fullName || targetUser.full_name),
    staffCode: req.body?.staffCode,
    loginUsername: (req.body?.username || targetUser.email.split('@')[0]),
      temporaryPassword: pw
    }).then(res => {
      console.log(`[ASYNC RESET EMAIL for ${targetUser.email}]:`, res);
    }).catch(err => {
      console.error(`[ASYNC RESET EMAIL ERROR for ${targetUser.email}]:`, err?.message || err);
    });
  }

  res.json({ ok: true, emailDispatched, mailResult });
});

router.post("/by-email/:email/resend-credentials", async (req, res) => {
  const email = req.params.email.toLowerCase().trim();
  const r = await pool.query("SELECT id, email, full_name FROM users WHERE LOWER(email) = $1", [email]);
  if (!r.rowCount) throw new HttpError(404, "Staff user not found in database for email: " + email);
  const targetUser = r.rows[0];

  const pw = req.body?.password;
  const tempPw = pw || `Fin@${Math.floor(100000 + Math.random() * 900000)}!`;
  if (!pw) {
    await pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [targetUser.id, await hashPassword(tempPw)]);
  }

  await audit(pool, { userId: req.user!.id, action: "resend_credentials", table: "users", recordId: targetUser.id, ip: req.ip });
  sendStaffCredentialsEmail({
    to: targetUser.email,
    staffId: (req.body?.staffCode || `STF-${targetUser.id}`),
    fullName: (req.body?.fullName || targetUser.full_name),
    staffCode: req.body?.staffCode,
    loginUsername: (req.body?.username || targetUser.email.split('@')[0]),
    temporaryPassword: tempPw
  }).then(res => {
    console.log(`[ASYNC RESEND EMAIL for ${targetUser.email}]:`, res);
  }).catch(err => {
    console.error(`[ASYNC RESEND EMAIL ERROR for ${targetUser.email}]:`, err?.message || err);
  });

  res.json({ ok: true, emailDispatched: true, mailResult: { success: true, message: "Resend initiated" }, temporaryPassword: tempPw });
});

router.post("/:id/resend-credentials", async (req, res) => {
  const reqEmail = req.body?.email?.toLowerCase()?.trim();
  let targetUser: any = null;

  const parsed = idParam.safeParse(req.params);
  if (parsed.success) {
    const r = await pool.query("SELECT id, email, full_name FROM users WHERE id = $1", [parsed.data.id]);
    if (r.rowCount) targetUser = r.rows[0];
  }

  if (!targetUser && reqEmail) {
    const r = await pool.query("SELECT id, email, full_name FROM users WHERE LOWER(email) = $1", [reqEmail]);
    if (r.rowCount) targetUser = r.rows[0];
  }

  if (!targetUser) throw new HttpError(404, "User not found in database");

  const pw = req.body?.password;
  const tempPw = pw || `Fin@${Math.floor(100000 + Math.random() * 900000)}!`;
  if (!pw) {
    await pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [targetUser.id, await hashPassword(tempPw)]);
  }

  await audit(pool, { userId: req.user!.id, action: "resend_credentials", table: "users", recordId: targetUser.id, ip: req.ip });
  sendStaffCredentialsEmail({
    to: targetUser.email,
    staffId: (req.body?.staffCode || `STF-${targetUser.id}`),
    fullName: (req.body?.fullName || targetUser.full_name),
    staffCode: req.body?.staffCode,
    loginUsername: (req.body?.username || targetUser.email.split('@')[0]),
    temporaryPassword: tempPw
  }).then(res => {
    console.log(`[ASYNC RESEND EMAIL for ${targetUser.email}]:`, res);
  }).catch(err => {
    console.error(`[ASYNC RESEND EMAIL ERROR for ${targetUser.email}]:`, err?.message || err);
  });

  res.json({ ok: true, emailDispatched: true, mailResult: { success: true, message: "Resend initiated" }, temporaryPassword: tempPw });
});

export default router;
