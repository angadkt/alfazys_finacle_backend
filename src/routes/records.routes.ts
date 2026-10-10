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

// Migration endpoint to seed cif_types, branches, and ensure orders table has all columns
router.get("/seed-cifs-temp", async (req, res) => {
  try {
    await pool.query(`
      ALTER TABLE cif_types ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE branches ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

      DO \$\$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM cif_types WHERE id = 1) THEN
          INSERT INTO cif_types (id, name, is_active) OVERRIDING SYSTEM VALUE VALUES (1, 'AGENT', true)
          ON CONFLICT (name) DO UPDATE SET is_active = true;
        ELSE
          UPDATE cif_types SET is_active = true WHERE id = 1;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM cif_types WHERE id = 2) THEN
          INSERT INTO cif_types (id, name, is_active) OVERRIDING SYSTEM VALUE VALUES (2, 'CUSTOMER', true)
          ON CONFLICT (name) DO UPDATE SET is_active = true;
        ELSE
          UPDATE cif_types SET is_active = true WHERE id = 2;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM cif_types WHERE id = 3) THEN
          INSERT INTO cif_types (id, name, is_active) OVERRIDING SYSTEM VALUE VALUES (3, 'EMPLOYEE', true)
          ON CONFLICT (name) DO UPDATE SET is_active = true;
        ELSE
          UPDATE cif_types SET is_active = true WHERE id = 3;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM cif_types WHERE id = 4) THEN
          INSERT INTO cif_types (id, name, is_active) OVERRIDING SYSTEM VALUE VALUES (4, 'OTHER', true)
          ON CONFLICT (name) DO UPDATE SET is_active = true;
        ELSE
          UPDATE cif_types SET is_active = true WHERE id = 4;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM cif_types WHERE id = 5) THEN
          INSERT INTO cif_types (id, name, is_active) OVERRIDING SYSTEM VALUE VALUES (5, 'GENERAL', true)
          ON CONFLICT (name) DO UPDATE SET is_active = true;
        ELSE
          UPDATE cif_types SET is_active = true WHERE id = 5;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM cif_types WHERE id = 6) THEN
          INSERT INTO cif_types (id, name, is_active) OVERRIDING SYSTEM VALUE VALUES (6, 'SERVICER', true)
          ON CONFLICT (name) DO UPDATE SET is_active = true;
        ELSE
          UPDATE cif_types SET is_active = true WHERE id = 6;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM cif_types WHERE id = 7) THEN
          INSERT INTO cif_types (id, name, is_active) OVERRIDING SYSTEM VALUE VALUES (7, 'SUPPLIER', true)
          ON CONFLICT (name) DO UPDATE SET is_active = true;
        ELSE
          UPDATE cif_types SET is_active = true WHERE id = 7;
        END IF;
      END \$\$;

      INSERT INTO branches (id, name, is_active) OVERRIDING SYSTEM VALUE VALUES 
      (1, 'UAE', true),
      (2, 'INDIA', true)
      ON CONFLICT (id) DO NOTHING;

      -- Ensure orders table has all columns
      ALTER TABLE orders ALTER COLUMN buyer_id DROP NOT NULL;
      ALTER TABLE orders DROP CONSTRAINT IF EXISTS gateway_needs_rates;
      ALTER TABLE orders DROP CONSTRAINT IF EXISTS usdt_needs_fields;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS party_id BIGINT REFERENCES parties(id);
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS receivers_data JSONB DEFAULT '[]';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS receiver_name TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS receiver_account TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS receiver_ifsc TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS receiver_bank TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS receiver_branch TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS transaction_through TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) DEFAULT 'Pending';

      -- Ensure credit_entries table has all columns
      ALTER TABLE credit_entries ADD COLUMN IF NOT EXISTS beneficiary_name TEXT;
      ALTER TABLE credit_entries ADD COLUMN IF NOT EXISTS account_number TEXT;
      ALTER TABLE credit_entries ADD COLUMN IF NOT EXISTS ifsc_code TEXT;
      ALTER TABLE credit_entries ADD COLUMN IF NOT EXISTS bank_name TEXT;
      ALTER TABLE credit_entries ADD COLUMN IF NOT EXISTS branch_name TEXT;
      ALTER TABLE credit_entries ADD COLUMN IF NOT EXISTS utrs_data JSONB DEFAULT '[]';
    `);
    res.send("<h1>Success! CIF Types, Branches, Orders, and Credit Entries schema updated & seeded.</h1>");
  } catch (err: any) {
    res.status(500).send(`<h1>Error</h1><p>${err.message}</p>`);
  }
});

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
 *             required: [title, first_name, last_name, short_name, gender, nationality, contact_number, ccy, branch_id, cif_type_id]
 *             properties:
 *               title: { type: string }
 *               first_name: { type: string }
 *               last_name: { type: string }
 *               short_name: { type: string }
 *               gender: { type: string }
 *               nationality: { type: string }
 *               contact_number: { type: string }
 *               ccy: { type: string }
 *               branch_id: { type: number }
 *               cif_type_id: { type: number }
 *               email: { type: string }
 *               _profile: { type: object }
 *             example:
 *               title: "Mr"
 *               first_name: "Aman"
 *               last_name: "Pk"
 *               short_name: "Aman"
 *               gender: "Male"
 *               nationality: "India"
 *               contact_number: "4252345234"
 *               ccy: "INR"
 *               branch_id: 1
 *               cif_type_id: 2
 *               email: "aman@example.com"
 *               _profile: { "contacts": [], "addresses": [] }
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
    party_id: z.coerce.number().optional().nullable(),
    entry_date: z.string(),
    aed_amount: z.coerce.number(),
    mode: z.string(),
    account_id: z.coerce.number().optional().nullable(),
    customer_rate: z.coerce.number(),
    utr_number: z.string().optional().nullable(),
    beneficiary_name: z.string().optional().nullable(),
    account_number: z.string().optional().nullable(),
    ifsc_code: z.string().optional().nullable(),
    bank_name: z.string().optional().nullable(),
    branch_name: z.string().optional().nullable(),
    utrs_data: z.any().optional(),
    note: z.string().optional().nullable()
  }).parse(req.body);

  const mf = makerFields(req.user!);
  
  const { rows } = await pool.query(
    `INSERT INTO credit_entries (
      party_id, entry_date, aed_amount, mode, account_id, customer_rate, utr_number, note, status, created_by, verified_by, verified_at,
      beneficiary_name, account_number, ifsc_code, bank_name, branch_name, utrs_data
     ) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *`,
    [
      body.party_id, body.entry_date, body.aed_amount, body.mode, body.account_id, body.customer_rate, body.utr_number, body.note, mf.status, mf.created_by, mf.verified_by, mf.verified_at,
      body.beneficiary_name, body.account_number, body.ifsc_code, body.bank_name, body.branch_name, JSON.stringify(body.utrs_data)
    ]
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
 *             properties:
 *               buyer_id: { type: number, nullable: true }
 *               party_id: { type: number, nullable: true }
 *               accounts:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     clientName: { type: string }
 *                     accountNumber: { type: string }
 *                     orderAmount: { type: string }
 *                     confirmOrderAmount: { type: string }
 *                     ifscCode: { type: string }
 *                     bankName: { type: string }
 *                     branchName: { type: string }
 *               txn: { type: string, enum: ["gateway", "usdt", "reverse"], default: "gateway" }
 *               order_date: { type: string, format: date }
 *               account_id: { type: number, nullable: true }
 *               note: { type: string, nullable: true }
 *     responses:
 *       201:
 *         description: Order entry created
 */
router.post("/orders", async (req, res) => {
  const body = z.object({
    buyer_id: z.coerce.number().optional().nullable(),
    party_id: z.coerce.number().optional().nullable(),
    accounts: z.array(z.any()).default([]), // The array of beneficiaries
    txn: z.enum(["gateway", "usdt", "reverse"]).default("gateway"),
    order_date: z.string(),
    account_id: z.coerce.number().optional().nullable(),
    transaction_through: z.string().optional().nullable(),
    payment_status: z.string().optional().default("Pending"),
    note: z.string().optional().nullable()
  }).parse(req.body);

  let total_inr = 0;
  let total_aed = 0;
  
  // Calculate total values from the multiple accounts passed
  if (body.accounts && body.accounts.length > 0) {
    body.accounts.forEach((acc: any) => {
      const parsedInr = parseFloat(acc.orderAmount);
      const inrAmt = isNaN(parsedInr) ? 0 : parsedInr;
      const parsedSaleRate = parseFloat(acc.confirmOrderAmount);
      const saleRate = isNaN(parsedSaleRate) ? 0 : parsedSaleRate;
      
      total_inr += inrAmt;
      if (saleRate > 0) {
        total_aed += inrAmt / saleRate;
      }
    });
  }

  // Use the first account's details for the legacy scalar columns for easy viewing
  const firstAcc = body.accounts[0] || {};
  const receiver_name = firstAcc.clientName || null;
  const receiver_account = firstAcc.accountNumber || null;
  const receiver_ifsc = firstAcc.ifscCode || null;
  const receiver_bank = firstAcc.bankName || null;
  const receiver_branch = firstAcc.branchName || null;
  
  const parsedFirstSaleRate = firstAcc.confirmOrderAmount ? parseFloat(firstAcc.confirmOrderAmount) : NaN;
  const sale_rate = isNaN(parsedFirstSaleRate) ? null : parsedFirstSaleRate;

  const mf = makerFields(req.user!);

  const { rows } = await pool.query(
    `INSERT INTO orders (
       buyer_id, party_id, receivers_data, receiver_name, receiver_account, receiver_ifsc, receiver_bank, receiver_branch,
       txn, order_date, aed_amount, account_id, sale_rate, cost_rate, usdt_amount, inr_per_usdt,
       inr_value, expected_profit_inr, note, status, created_by, verified_by, verified_at,
       transaction_through, payment_status
     ) 
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25) RETURNING *`,
    [
      body.buyer_id, body.party_id, JSON.stringify(body.accounts), receiver_name, receiver_account, receiver_ifsc, receiver_bank, receiver_branch,
      body.txn, body.order_date, total_aed, body.account_id, sale_rate, null, null, null,
      total_inr, null, body.note, mf.status, mf.created_by, mf.verified_by, mf.verified_at,
      body.transaction_through || null, body.payment_status || 'Pending'
    ]
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
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string) || 20));
  const search = req.query.search as string || "";
  const offset = (page - 1) * limit;

  let whereClause = "WHERE 1=1";
  const params: any[] = [];

  if (search) {
    params.push(`%${search}%`);
    whereClause += ` AND (
      o.order_no ILIKE $1 OR 
      o.receiver_name ILIKE $1 OR 
      o.receiver_account ILIKE $1 OR 
      o.receivers_data::text ILIKE $1 OR 
      o.status ILIKE $1 OR 
      TRIM(p.first_name || ' ' || COALESCE(p.last_name, '')) ILIKE $1
    )`;
  }

  const countQuery = `
    SELECT COUNT(*) 
    FROM orders o 
    LEFT JOIN parties p ON o.party_id = p.id 
    ${whereClause}
  `;
  const totalRes = await pool.query(countQuery, params);
  const total = parseInt(totalRes.rows[0].count);

  const query = `
    SELECT o.*, 
           maker.full_name as created_by_name, 
           checker.full_name as verified_by_name,
           TRIM(p.first_name || ' ' || COALESCE(p.last_name, '')) as party_name
    FROM orders o
    LEFT JOIN users maker ON o.created_by = maker.id
    LEFT JOIN users checker ON o.verified_by = checker.id
    LEFT JOIN parties p ON o.party_id = p.id
    ${whereClause}
    ORDER BY o.created_at DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;

  const { rows } = await pool.query(query, [...params, limit, offset]);

  res.json({ records: rows, total, page, limit });
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
