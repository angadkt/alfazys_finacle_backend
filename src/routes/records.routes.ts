import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware";
import { deleteOrRequest, editRecord, makerFields } from "../makerChecker";
import { pool, tx } from "../db";
import { audit } from "../audit";

/**
 * Generic edit and delete for any table in the registry.
 * Super admin: applied at once.
 * Staff: own pending records are edited directly. Verified records become a request.
 */
const router = Router();
router.use(requireAuth);

const params = z.object({ table: z.string(), id: z.string().regex(/^\d+$/) });
const dataSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

/**
 * @openapi
 * /records/credit:
 *   post:
 *     summary: Add a Credit Entry
 *     tags: [Records]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - party_id
 *               - entry_date
 *               - aed_amount
 *               - mode
 *               - account_id
 *               - customer_rate
 *             properties:
 *               party_id: { type: string }
 *               entry_date: { type: string, format: date }
 *               aed_amount: { type: number }
 *               mode: { type: string }
 *               account_id: { type: string }
 *               customer_rate: { type: number }
 *               utr_number: { type: string }
 *               note: { type: string }
 *     responses:
 *       201:
 *         description: Credit entry created
 */
router.post("/credit", async (req, res) => {
  const body = z.object({
    party_id: z.coerce.number(),
    entry_date: z.string(),
    aed_amount: z.coerce.number(),
    mode: z.string(),
    account_id: z.coerce.number(),
    customer_rate: z.coerce.number(),
    utr_number: z.string().optional().nullable(),
    note: z.string().optional().nullable()
  }).parse(req.body);

  const mf = makerFields(req.user!);
  
  const { rows } = await pool.query(
    `INSERT INTO credit_entries (party_id, entry_date, aed_amount, mode, account_id, customer_rate, utr_number, note, status, created_by, verified_by, verified_at) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [body.party_id, body.entry_date, body.aed_amount, body.mode, body.account_id, body.customer_rate, body.utr_number, body.note, mf.status, mf.created_by, mf.verified_by, mf.verified_at]
  );
  
  await audit(pool, { userId: req.user!.id, action: "create", table: "credit_entries", recordId: rows[0].id, newData: rows[0], ip: req.ip });
  res.status(201).json({ record: rows[0] });
});

/**
 * @openapi
 * /records/credit:
 *   get:
 *     summary: Get all Credit Entries
 *     tags: [Records]
 *     responses:
 *       200:
 *         description: List of credit entries
 */
router.get("/credit", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.*, 
           maker.full_name as created_by_name, 
           checker.full_name as verified_by_name
    FROM credit_entries c
    LEFT JOIN users maker ON c.created_by = maker.id
    LEFT JOIN users checker ON c.verified_by = checker.id
    ORDER BY c.created_at DESC
  `);
  res.json({ records: rows });
});

/**
 * @openapi
 * /records/credit/{id}:
 *   patch:
 *     summary: Edit a Credit Entry
 *     tags: [Records]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Include only the fields you wish to update
 *     responses:
 *       200:
 *         description: Record updated or change requested
 */
router.patch("/credit/:id", async (req, res) => {
  const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
  const data = dataSchema.parse(req.body);
  res.json(await editRecord(req.user!, "credit_entries", id, data, req.ip));
});

/**
 * @openapi
 * /records/credit/{id}:
 *   delete:
 *     summary: Delete a Credit Entry
 *     tags: [Records]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Record deleted or delete requested
 */
router.delete("/credit/:id", async (req, res) => {
  const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
  res.json(await deleteOrRequest(req.user!, "credit_entries", id, req.ip));
});

/**
 * @openapi
 * /records/orders:
 *   post:
 *     summary: Add an Order Entry
 *     tags: [Records]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - buyer_id
 *               - txn
 *               - order_date
 *               - aed_amount
 *             properties:
 *               buyer_id: { type: string }
 *               txn: { type: string }
 *               order_date: { type: string, format: date }
 *               aed_amount: { type: number }
 *               account_id: { type: string }
 *               sale_rate: { type: number }
 *               cost_rate: { type: number }
 *               usdt_amount: { type: number }
 *               inr_per_usdt: { type: number }
 *               note: { type: string }
 *     responses:
 *       201:
 *         description: Order entry created
 */
router.post("/orders", async (req, res) => {
  const body = z.object({
    buyer_id: z.coerce.number(),
    txn: z.enum(["gateway", "usdt", "reverse"]).default("gateway"),
    order_date: z.string(),
    aed_amount: z.coerce.number(),
    account_id: z.coerce.number().optional().nullable(),
    sale_rate: z.coerce.number().optional().nullable(),
    cost_rate: z.coerce.number().optional().nullable(),
    usdt_amount: z.coerce.number().optional().nullable(),
    inr_per_usdt: z.coerce.number().optional().nullable(),
    note: z.string().optional().nullable()
  }).parse(req.body);

  let inr_value = 0;
  let expected_profit_inr = null;

  if (body.txn === "gateway") {
    inr_value = body.aed_amount * (body.cost_rate || 0);
    expected_profit_inr = ((body.cost_rate || 0) - (body.sale_rate || 0)) * body.aed_amount;
  } else if (body.txn === "usdt") {
    inr_value = (body.usdt_amount || 0) * (body.inr_per_usdt || 0);
  }

  const mf = makerFields(req.user!);

  const { rows } = await pool.query(
    `INSERT INTO orders (buyer_id, txn, order_date, aed_amount, account_id, sale_rate, cost_rate, usdt_amount, inr_per_usdt, inr_value, expected_profit_inr, note, status, created_by, verified_by, verified_at) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
    [body.buyer_id, body.txn, body.order_date, body.aed_amount, body.account_id, body.sale_rate, body.cost_rate, body.usdt_amount, body.inr_per_usdt, inr_value, expected_profit_inr, body.note, mf.status, mf.created_by, mf.verified_by, mf.verified_at]
  );
  
  await audit(pool, { userId: req.user!.id, action: "create", table: "orders", recordId: rows[0].id, newData: rows[0], ip: req.ip });
  res.status(201).json({ record: rows[0] });
});

/**
 * @openapi
 * /records/orders:
 *   get:
 *     summary: Get all Order Entries
 *     tags: [Records]
 *     responses:
 *       200:
 *         description: List of order entries
 */
router.get("/orders", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT o.*, 
           maker.full_name as created_by_name, 
           checker.full_name as verified_by_name
    FROM orders o
    LEFT JOIN users maker ON o.created_by = maker.id
    LEFT JOIN users checker ON o.verified_by = checker.id
    ORDER BY o.created_at DESC
  `);
  res.json({ records: rows });
});

/**
 * @openapi
 * /records/orders/{id}:
 *   patch:
 *     summary: Edit an Order Entry
 *     tags: [Records]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Include only the fields you wish to update
 *     responses:
 *       200:
 *         description: Record updated or change requested
 */
router.patch("/orders/:id", async (req, res) => {
  const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
  const data = dataSchema.parse(req.body);
  res.json(await editRecord(req.user!, "orders", id, data, req.ip));
});

/**
 * @openapi
 * /records/orders/{id}:
 *   delete:
 *     summary: Delete an Order Entry
 *     tags: [Records]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Record deleted or delete requested
 */
router.delete("/orders/:id", async (req, res) => {
  const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
  res.json(await deleteOrRequest(req.user!, "orders", id, req.ip));
});

router.patch("/:table/:id", async (req, res) => {
  const { table, id } = params.parse(req.params);
  const data = dataSchema.parse(req.body);
  res.json(await editRecord(req.user!, table, id, data, req.ip));
});

router.delete("/:table/:id", async (req, res) => {
  const { table, id } = params.parse(req.params);
  res.json(await deleteOrRequest(req.user!, table, id, req.ip));
});

export default router;
