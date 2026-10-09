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
const dataSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null(), z.object({}).passthrough(), z.array(z.object({}).passthrough())]));

/**
 * @openapi
 * /records/parties:
 *   post:
 *     summary: Create a CIF / Party
 *     tags: [Records]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [first_name, contact_number]
 *             properties:
 *               first_name: { type: string }
 *               last_name: { type: string }
 *               contact_number: { type: string }
 *               email: { type: string }
 *               _profile: { type: object }
 *     responses:
 *       201:
 *         description: CIF created
 */
router.post("/parties", async (req, res) => {
  const body = z.object({
    title: z.string().trim().min(1),
    first_name: z.string().trim().min(1),
    last_name: z.string().trim().min(1),
    short_name: z.string().trim().min(1),
    gender: z.string().min(1),
    nationality: z.string().min(1),
    contact_number: z.string().trim().min(1),
    ccy: z.string().min(1),
    branch_id: z.coerce.number(),
    cif_type_id: z.coerce.number(),
    email: z.string().email().optional().nullable().or(z.literal("")),
    indian_number: z.string().optional().nullable(),
    whatsapp_number: z.string().optional().nullable(),
    _profile: z.object({
      contacts: z.array(z.object({
        number: z.string(),
        relation: z.string()
      })).optional(),
      addresses: z.array(z.object({
        address_format: z.string().optional(),
        address_type: z.string().optional(),
        house_no: z.string().optional(),
        premise_name: z.string().optional().nullable(),
        building_level: z.string().optional().nullable(),
        street_no: z.string().optional(),
        suburb: z.string().optional().nullable(),
        street_name: z.string().optional(),
        locality: z.string().optional().nullable(),
        town: z.string().optional().nullable(),
        city: z.string().optional(),
        state: z.string().optional(),
        country: z.string().optional(),
        postal_code: z.string().optional(),
        valid_from: z.string().optional(),
        valid_till: z.string().optional().nullable(),
        address_proof_received: z.boolean().or(z.enum(["Yes", "No"])).optional().nullable()
      })).optional()
    }).optional().nullable()
  }).parse(req.body);

  const mf = makerFields(req.user!);

  const record = await tx(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO parties (first_name, last_name, short_name, gender, nationality, contact_number, branch_id, cif_type_id, email, indian_number, whatsapp_number, status, created_by, verified_by, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, ''), $10, $11, $12, $13, $14, $15) RETURNING *`,
      [body.first_name, body.last_name, body.short_name, body.gender, body.nationality, body.contact_number, body.branch_id, body.cif_type_id, body.email, body.indian_number, body.whatsapp_number, mf.status, mf.created_by, mf.verified_by, mf.verified_at]
    );
    const party = rows[0];

    if (body._profile) {
      if (body._profile.contacts) {
        for (const con of body._profile.contacts) {
          await c.query("INSERT INTO party_contacts (party_id, number, relation) VALUES ($1, $2, $3)", [party.id, con.number, con.relation]);
        }
      }
      if (body._profile.addresses) {
        for (const addr of body._profile.addresses) {
          await c.query(`INSERT INTO party_addresses 
            (party_id, address_format, address_type, house_no, premise_name, building_level, street_no, suburb, street_name, locality, town, city, state, country, postal_code, valid_from, valid_till, address_proof_received) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, COALESCE(NULLIF($16, ''), CURRENT_DATE::text)::date, NULLIF($17, '')::date, $18)`, 
            [party.id, addr.address_format, addr.address_type, addr.house_no, addr.premise_name, addr.building_level, addr.street_no, addr.suburb, addr.street_name, addr.locality, addr.town, addr.city, addr.state, addr.country, addr.postal_code, addr.valid_from, addr.valid_till, addr.address_proof_received === "Yes" || addr.address_proof_received === true]);
        }
      }
    }
    
    await audit(c, { userId: req.user!.id, action: "create", table: "parties", recordId: party.id, newData: { ...party, _profile: body._profile }, ip: req.ip });
    return party;
  });

  res.status(201).json({ record });
});

/**
 * @openapi
 * /records/parties:
 *   get:
 *     summary: Get all Parties (CIFs)
 *     tags: [Records]
 *     responses:
 *       200:
 *         description: List of parties
 */
router.get("/parties", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.*,
           maker.full_name as created_by_name,
           checker.full_name as verified_by_name,
           (SELECT json_agg(c) FROM party_contacts c WHERE c.party_id = p.id) as contacts,
           (SELECT json_agg(a) FROM party_addresses a WHERE a.party_id = p.id) as addresses
    FROM parties p
    LEFT JOIN users maker ON p.created_by = maker.id
    LEFT JOIN users checker ON p.verified_by = checker.id
    ORDER BY p.created_at DESC
  `);
  res.json({ records: rows });
});

/**
 * @openapi
 * /records/parties/{id}:
 *   patch:
 *     summary: Edit a CIF / Party
 *     tags: [Records]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Record updated
 */
router.patch("/parties/:id", async (req, res) => {
  const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
  const data = dataSchema.parse(req.body);
  res.json(await editRecord(req.user!, "parties", id, data, req.ip));
});

/**
 * @openapi
 * /records/parties/{id}:
 *   delete:
 *     summary: Delete a CIF / Party
 *     tags: [Records]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Record deleted
 */
router.delete("/parties/:id", async (req, res) => {
  const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
  res.json(await deleteOrRequest(req.user!, "parties", id, req.ip));
});


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
