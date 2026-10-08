import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireModule, requireSuperAdmin } from "../auth/middleware";
import { pool, tx } from "../db";
import { HttpError } from "../errors";
import { audit } from "../audit";

const router = Router();
router.use(requireAuth);

const ALLOWED_MASTERS = ["cif_types", "branches", "expense_categories", "accounts", "buyers"] as const;

const tableSchema = z.enum(ALLOWED_MASTERS);

// Master schemas
const basicSchema = z.object({
  name: z.string().min(1),
  is_active: z.boolean().optional(),
});

const accountsSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(["cash", "bank"]),
  currency: z.enum(["AED", "INR", "USDT"]),
  opening_balance: z.string().regex(/^\d+(\.\d{1,2})?$/, "Must be a valid amount"),
  is_active: z.boolean().optional(),
});

const buyersSchema = z.object({
  name: z.string().min(1),
  contact_number: z.string().optional().nullable(),
  commission_type: z.enum(["percent", "fixed"]).optional().nullable(),
  commission_value: z.string().regex(/^\d+(\.\d{1,4})?$/).optional().nullable(),
  commission_basis: z.enum(["aed", "inr"]).optional().nullable(),
  is_active: z.boolean().optional(),
});

router.get("/:table", requireModule("financial", "view"), async (req, res) => {
  const table = tableSchema.parse(req.params.table);
  const includeInactive = req.user?.role === "super_admin" && req.query.all === "true";
  
  let q = `SELECT * FROM ${table}`;
  if (!includeInactive) {
    q += ` WHERE is_active = true`;
  }
  q += ` ORDER BY id ASC`;
  
  const { rows } = await pool.query(q);
  res.json(rows);
});

router.post("/:table", requireSuperAdmin, async (req, res) => {
  const table = tableSchema.parse(req.params.table);
  let data: Record<string, any>;
  
  if (table === "accounts") data = accountsSchema.parse(req.body);
  else if (table === "buyers") data = buyersSchema.parse(req.body);
  else data = basicSchema.parse(req.body);

  const keys = Object.keys(data);
  const cols = keys.join(", ");
  const vals = keys.map((_, i) => `$${i + 1}`).join(", ");
  
  try {
    const result = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO ${table} (${cols}) VALUES (${vals}) RETURNING *`,
        keys.map(k => data[k])
      );
      await audit(c, {
        userId: req.user!.id,
        action: "create",
        table,
        recordId: rows[0].id,
        newData: rows[0],
        ip: req.ip
      });
      return rows[0];
    });
    res.json(result);
  } catch (err: any) {
    if (err.code === "23505") throw new HttpError(409, "A record with this name/unique field already exists");
    throw err;
  }
});

router.patch("/:table/:id", requireSuperAdmin, async (req, res) => {
  const table = tableSchema.parse(req.params.table);
  const id = z.string().regex(/^\d+$/).parse(req.params.id);
  
  let data: Record<string, any>;
  // For PATCH, we make all fields optional
  if (table === "accounts") data = accountsSchema.partial().parse(req.body);
  else if (table === "buyers") data = buyersSchema.partial().parse(req.body);
  else data = basicSchema.partial().parse(req.body);

  const keys = Object.keys(data);
  if (keys.length === 0) throw new HttpError(400, "No fields to change");

  const sets = keys.map((col, i) => `${col} = $${i + 2}`).join(", ");
  
  try {
    const result = await tx(async (c) => {
      const old = await c.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
      if (!old.rows[0]) throw new HttpError(404, "Record not found");

      const { rows } = await c.query(
        `UPDATE ${table} SET ${sets} WHERE id = $1 RETURNING *`,
        [id, ...keys.map(k => data[k])]
      );
      await audit(c, {
        userId: req.user!.id,
        action: "update",
        table,
        recordId: id,
        oldData: old.rows[0],
        newData: rows[0],
        ip: req.ip
      });
      return rows[0];
    });
    res.json(result);
  } catch (err: any) {
    if (err.code === "23505") throw new HttpError(409, "A record with this name/unique field already exists");
    throw err;
  }
});

export default router;
