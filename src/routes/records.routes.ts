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

      ALTER TABLE party_documents ADD COLUMN IF NOT EXISTS file_data BYTEA;
      ALTER TABLE party_documents ADD COLUMN IF NOT EXISTS mime_type TEXT;
      ALTER TABLE party_documents ADD COLUMN IF NOT EXISTS file_name TEXT;
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

  // Deduplication guard: prevent identical party creation within a 10-second window
  const recentDuplicate = await pool.query(
    `SELECT * FROM parties 
     WHERE first_name = $1 
       AND last_name = $2 
       AND contact_number = $3 
       AND created_at >= NOW() - INTERVAL '10 seconds'
     ORDER BY created_at DESC LIMIT 1`,
    [body.first_name, body.last_name, body.contact_number]
  );
  if (recentDuplicate.rows.length > 0) {
    return res.status(200).json({ record: recentDuplicate.rows[0], duplicatePrevented: true });
  }

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

  // Deduplication guard: prevent identical credit entries within a 10-second window
  const recentCreditDuplicate = await pool.query(
    `SELECT * FROM credit_entries 
     WHERE entry_date = $1 
       AND aed_amount = $2 
       AND account_number IS NOT DISTINCT FROM $3 
       AND beneficiary_name IS NOT DISTINCT FROM $4
       AND created_at >= NOW() - INTERVAL '10 seconds'
     ORDER BY created_at DESC LIMIT 1`,
    [body.entry_date, body.aed_amount, body.account_number, body.beneficiary_name]
  );
  if (recentCreditDuplicate.rows.length > 0) {
    return res.status(200).json({ record: recentCreditDuplicate.rows[0], duplicatePrevented: true });
  }
  
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

  // Deduplication guard: prevent identical orders within a 10-second window
  const recentOrderDuplicate = await pool.query(
    `SELECT * FROM orders 
     WHERE party_id IS NOT DISTINCT FROM $1 
       AND order_date = $2 
       AND inr_value = $3 
       AND aed_amount = $4 
       AND created_at >= NOW() - INTERVAL '10 seconds'
     ORDER BY created_at DESC LIMIT 1`,
    [body.party_id, body.order_date, total_inr, total_aed]
  );
  if (recentOrderDuplicate.rows.length > 0) {
    return res.status(200).json({ record: recentOrderDuplicate.rows[0], duplicatePrevented: true });
  }

  // Check if an active order already exists for this same agent on this same date
  if (body.party_id) {
    const existingOrderRes = await pool.query(
      `SELECT * FROM orders 
       WHERE party_id = $1 
         AND order_date = $2::date 
         AND status != 'rejected'
       ORDER BY id ASC 
       LIMIT 1`,
      [body.party_id, body.order_date]
    );

    if (existingOrderRes.rows.length > 0) {
      const existingOrder = existingOrderRes.rows[0];

      let existingAccounts: any[] = [];
      if (typeof existingOrder.receivers_data === 'string') {
        try { existingAccounts = JSON.parse(existingOrder.receivers_data); } catch { existingAccounts = []; }
      } else if (Array.isArray(existingOrder.receivers_data)) {
        existingAccounts = existingOrder.receivers_data;
      }

      // Merge newly added accounts into the existing order accounts list
      const mergedAccounts = [...existingAccounts, ...(body.accounts || [])];

      let combined_inr = 0;
      let combined_aed = 0;
      mergedAccounts.forEach((acc: any) => {
        const parsedInr = parseFloat(acc.orderAmount);
        const inrAmt = isNaN(parsedInr) ? 0 : parsedInr;
        const parsedSaleRate = parseFloat(acc.confirmOrderAmount);
        const saleRate = isNaN(parsedSaleRate) ? 0 : parsedSaleRate;

        combined_inr += inrAmt;
        if (saleRate > 0) {
          combined_aed += inrAmt / saleRate;
        }
      });

      // Daily cost rate check
      const dailyRateRes = await pool.query(
        `SELECT cost_rate FROM daily_rates WHERE rate_date = $1 LIMIT 1`,
        [body.order_date]
      );
      const cost_rate = dailyRateRes.rows[0] ? parseFloat(dailyRateRes.rows[0].cost_rate) : (existingOrder.cost_rate ? parseFloat(existingOrder.cost_rate) : null);
      const expected_profit_inr = (cost_rate && combined_aed > 0)
        ? Math.round(((cost_rate * combined_aed) - combined_inr) * 100) / 100
        : null;

      // Status determination across all merged receivers
      const anyPending = mergedAccounts.some((a: any) => !a.payment_status || a.payment_status.toLowerCase() === 'pending');
      const anyPaid = mergedAccounts.some((a: any) => a.payment_status && a.payment_status.toLowerCase() === 'paid');
      const anyPartial = mergedAccounts.some((a: any) => a.payment_status && a.payment_status.toLowerCase() === 'partial');
      let overallPaymentStatus = 'Pending';
      if (!anyPending && !anyPartial && anyPaid) {
        overallPaymentStatus = 'Paid';
      } else if (anyPaid || anyPartial) {
        overallPaymentStatus = 'Partial';
      }

      const { updatedRows } = await tx(async (c) => {
        await c.query("SELECT set_config('app.allow_verified_change', 'on', true)");
        const { rows } = await c.query(
          `UPDATE orders SET
             receivers_data = $1,
             aed_amount = $2,
             inr_value = $3,
             cost_rate = COALESCE($4, cost_rate),
             expected_profit_inr = $5,
             payment_status = $6,
             transaction_through = COALESCE($7, transaction_through)
           WHERE id = $8
           RETURNING *`,
          [
            JSON.stringify(mergedAccounts),
            combined_aed,
            combined_inr,
            cost_rate,
            expected_profit_inr,
            overallPaymentStatus,
            body.transaction_through || null,
            existingOrder.id
          ]
        );
        return { updatedRows: rows };
      });

      await audit(pool, {
        userId: req.user!.id,
        action: "update",
        table: "orders",
        recordId: existingOrder.id,
        oldData: existingOrder,
        newData: updatedRows[0],
        ip: req.ip
      });

      return res.status(200).json({
        record: updatedRows[0],
        merged: true,
        message: `Accounts appended to existing order ${existingOrder.order_no || `OR-${existingOrder.id}`}`
      });
    }
  }

  // Check if daily cost rate exists for this order date
  const dailyRateRes = await pool.query(
    `SELECT cost_rate FROM daily_rates WHERE rate_date = $1 LIMIT 1`,
    [body.order_date]
  );
  const cost_rate = dailyRateRes.rows[0] ? parseFloat(dailyRateRes.rows[0].cost_rate) : null;
  const expected_profit_inr = (cost_rate && total_aed > 0) 
    ? Math.round(((cost_rate * total_aed) - total_inr) * 100) / 100 
    : null;

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
      body.txn, body.order_date, total_aed, body.account_id, sale_rate, cost_rate, null, null,
      total_inr, expected_profit_inr, body.note, mf.status, mf.created_by, mf.verified_by, mf.verified_at,
      body.transaction_through || null, body.payment_status || 'Pending'
    ]
  );
  
  await audit(pool, { userId: req.user!.id, action: "create", table: "orders", recordId: rows[0].id, newData: rows[0], ip: req.ip });
  res.status(201).json({ record: rows[0] });
});

/**
 * @openapi
 * /records/orders/{id}:
 *   put:
 *     summary: Update an Order Entry completely
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
 *             properties:
 *               buyer_id: { type: number, nullable: true }
 *               party_id: { type: number, nullable: true }
 *               accounts:
 *                 type: array
 *                 items: { type: object }
 *               txn: { type: string }
 *               order_date: { type: string, format: date }
 *               account_id: { type: number, nullable: true }
 *               transaction_through: { type: string, nullable: true }
 *               payment_status: { type: string }
 *               note: { type: string, nullable: true }
 *     responses:
 *       200:
 *         description: Order entry updated
 */
router.put("/orders/:id", async (req, res) => {
  const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
  
  const body = z.object({
    buyer_id: z.coerce.number().optional().nullable(),
    party_id: z.coerce.number().optional().nullable(),
    accounts: z.array(z.any()).default([]),
    txn: z.enum(["gateway", "usdt", "reverse"]).default("gateway"),
    order_date: z.string(),
    account_id: z.coerce.number().optional().nullable(),
    transaction_through: z.string().optional().nullable(),
    payment_status: z.string().optional().default("Pending"),
    note: z.string().optional().nullable()
  }).parse(req.body);

  let total_inr = 0;
  let total_aed = 0;
  
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

  const firstAcc = body.accounts[0] || {};
  const receiver_name = firstAcc.clientName || null;
  const receiver_account = firstAcc.accountNumber || null;
  const receiver_ifsc = firstAcc.ifscCode || null;
  const receiver_bank = firstAcc.bankName || null;
  const receiver_branch = firstAcc.branchName || null;
  
  const parsedFirstSaleRate = firstAcc.confirmOrderAmount ? parseFloat(firstAcc.confirmOrderAmount) : NaN;
  const sale_rate = isNaN(parsedFirstSaleRate) ? null : parsedFirstSaleRate;

  // Retrieve old record for audit
  const { rows: oldRows } = await pool.query(`SELECT * FROM orders WHERE id = $1`, [id]);
  if (!oldRows[0]) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  
  const mf = makerFields(req.user!);

  // Check if daily cost rate exists for this order date
  const dailyRateRes = await pool.query(
    `SELECT cost_rate FROM daily_rates WHERE rate_date = $1 LIMIT 1`,
    [body.order_date]
  );
  const cost_rate = dailyRateRes.rows[0]
    ? parseFloat(dailyRateRes.rows[0].cost_rate)
    : (oldRows[0].cost_rate ? parseFloat(oldRows[0].cost_rate) : null);
  const expected_profit_inr = (cost_rate && total_aed > 0)
    ? Math.round(((cost_rate * total_aed) - total_inr) * 100) / 100
    : null;

  // Update inside a transaction, with the verified-record guard lifted
  const { updated: updatedRow } = await tx(async (c) => {
    await c.query("SELECT set_config('app.allow_verified_change', 'on', true)");

    const { rows: updated } = await c.query(
      `UPDATE orders SET
         buyer_id = $1, party_id = $2, receivers_data = $3, receiver_name = $4, receiver_account = $5, receiver_ifsc = $6, receiver_bank = $7, receiver_branch = $8,
         txn = $9, order_date = $10, aed_amount = $11, account_id = $12, sale_rate = $13,
         inr_value = $14, note = $15, status = $16, transaction_through = $17, payment_status = $18,
         cost_rate = $19, expected_profit_inr = $20
       WHERE id = $21 RETURNING *`,
      [
        body.buyer_id, body.party_id, JSON.stringify(body.accounts), receiver_name, receiver_account, receiver_ifsc, receiver_bank, receiver_branch,
        body.txn, body.order_date, total_aed, body.account_id, sale_rate,
        total_inr, body.note, oldRows[0].status === 'verified' ? 'verified' : mf.status, body.transaction_through || null, body.payment_status || 'Pending',
        cost_rate, expected_profit_inr,
        id
      ]
    );

    await audit(c, {
      userId: req.user!.id,
      action: "update",
      table: "orders",
      recordId: id,
      oldData: oldRows[0],
      newData: updated[0],
      ip: req.ip
    });

    return { updated: updated[0] };
  });

  res.json({ record: updatedRow });
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
  const date = req.query.date as string || "";
  const fromDate = (req.query.from_date as string) || (req.query.fromDate as string) || "";
  const toDate = (req.query.to_date as string) || (req.query.toDate as string) || "";
  const partyId = req.query.party_id as string || "";
  const offset = (page - 1) * limit;

  let whereClause = "WHERE 1=1";
  const params: any[] = [];

  if (search) {
    params.push(`%${search}%`);
    const idx = params.length;
    whereClause += ` AND (
      o.order_no ILIKE $${idx} OR 
      o.receiver_name ILIKE $${idx} OR 
      o.receiver_account ILIKE $${idx} OR 
      o.receivers_data::text ILIKE $${idx} OR 
      o.status ILIKE $${idx} OR 
      TRIM(p.first_name || ' ' || COALESCE(p.last_name, '')) ILIKE $${idx}
    )`;
  }

  if (fromDate && toDate) {
    params.push(fromDate);
    const fromIdx = params.length;
    params.push(toDate);
    const toIdx = params.length;
    whereClause += ` AND o.order_date >= $${fromIdx} AND o.order_date <= $${toIdx}`;
  } else if (fromDate) {
    params.push(fromDate);
    whereClause += ` AND o.order_date >= $${params.length}`;
  } else if (toDate) {
    params.push(toDate);
    whereClause += ` AND o.order_date <= $${params.length}`;
  } else if (date) {
    params.push(date);
    whereClause += ` AND o.order_date = $${params.length}`;
  }

  if (partyId) {
    params.push(partyId);
    whereClause += ` AND o.party_id = $${params.length}`;
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

router.put("/received-aed/:id", async (req, res) => {
  const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
  const body = z.object({
    aed_amount: z.number().positive(),
    collection_staff: z.string().min(1).optional().nullable(),
    mode_of_txn: z.string().min(1),
    cash_staff: z.string().optional().nullable(),
    remaining_amount: z.number().optional().nullable(),
    entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    agent_customer: z.string().optional().nullable(),
    utr_no: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
  }).parse(req.body);

  const entryDate = body.entry_date || new Date().toISOString().slice(0, 10);

  const oldRes = await pool.query("SELECT * FROM received_aed WHERE id = $1", [id]);
  if (!oldRes.rows[0]) {
    return res.status(404).json({ error: "Record not found" });
  }

  const { rows } = await pool.query(
    `UPDATE received_aed
     SET aed_amount = $1,
         collection_staff = $2,
         mode_of_txn = $3,
         cash_staff = $4,
         remaining_amount = $5,
         entry_date = $6,
         agent_customer = $7,
         utr_no = $8,
         description = $9
     WHERE id = $10
     RETURNING *`,
    [
      body.aed_amount,
      body.collection_staff || null,
      body.mode_of_txn,
      body.cash_staff || null,
      body.remaining_amount ?? null,
      entryDate,
      body.agent_customer ? body.agent_customer.trim() : null,
      body.utr_no ? body.utr_no.trim() : null,
      body.description ? body.description.trim() : null,
      id
    ]
  );

  await audit(pool, {
    userId: req.user!.id,
    action: "update",
    table: "received_aed",
    recordId: id,
    oldData: oldRes.rows[0],
    newData: rows[0],
    ip: req.ip,
  });

  res.json({ record: rows[0] });
});

router.delete("/received-aed/:id", async (req, res) => {
  const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);

  const oldRes = await pool.query("SELECT * FROM received_aed WHERE id = $1", [id]);
  if (!oldRes.rows[0]) {
    return res.status(404).json({ error: "Record not found" });
  }

  await pool.query("DELETE FROM received_aed WHERE id = $1", [id]);

  await audit(pool, {
    userId: req.user!.id,
    action: "delete",
    table: "received_aed",
    recordId: id,
    oldData: oldRes.rows[0],
    ip: req.ip,
  });

  res.json({ success: true, message: "Record deleted" });
});

/**
 * @openapi
 * /records/orders/{id}/receiver/{index}:
 *   patch:
 *     summary: Update payment status of a single receiver within an order
 *     tags: [Records]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: index
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               payment_status:
 *                 type: string
 *     responses:
 *       200:
 *         description: Receiver payment status updated
 */
router.patch("/orders/:id/receiver/:index", async (req, res) => {
  const { id } = z.object({ id: z.string().regex(/^\d+$/) }).parse(req.params);
  const recIndex = parseInt(req.params.index);
  const { payment_status, paid_amount } = z.object({
    payment_status: z.string().min(1),
    paid_amount: z.union([z.number(), z.string()]).optional().nullable()
  }).parse(req.body);

  if (isNaN(recIndex) || recIndex < 0) {
    res.status(400).json({ message: "Invalid receiver index" });
    return;
  }

  // Fetch current order
  const { rows: orderRows } = await pool.query(
    "SELECT receivers_data FROM orders WHERE id = $1",
    [id]
  );
  if (orderRows.length === 0) {
    res.status(404).json({ message: "Order not found" });
    return;
  }

  let recs: any[] = orderRows[0].receivers_data;
  if (typeof recs === "string") {
    try { recs = JSON.parse(recs); } catch { recs = []; }
  }
  if (!Array.isArray(recs) || recIndex >= recs.length) {
    res.status(400).json({ message: "Receiver index out of range" });
    return;
  }

  let numericPaid = 0;
  if (paid_amount !== undefined && paid_amount !== null && paid_amount !== "") {
    numericPaid = typeof paid_amount === "number" ? paid_amount : parseFloat(String(paid_amount).replace(/,/g, ""));
    if (isNaN(numericPaid) || numericPaid < 0) numericPaid = 0;
  } else if (payment_status.toLowerCase() === "paid") {
    numericPaid = parseFloat(String(recs[recIndex]?.orderAmount || 0).replace(/,/g, "")) || 0;
  } else if (payment_status.toLowerCase() === "pending" || payment_status.toLowerCase() === "cancelled") {
    numericPaid = 0;
  } else {
    numericPaid = parseFloat(String(recs[recIndex]?.paid_amount || 0).replace(/,/g, "")) || 0;
  }

  // Update the specific receiver's payment_status and paid_amount
  recs[recIndex] = { ...recs[recIndex], payment_status, paid_amount: numericPaid };

  // Compute aggregate order-level payment_status
  const statuses = recs.map((r: any) => (r.payment_status || "Pending").toLowerCase());
  const allPaid = statuses.every((s: string) => s === "paid");
  const nonePaid = statuses.every((s: string) => s === "pending" || s === "cancelled");
  const hasPartial = statuses.some((s: string) => s === "partial") || (!allPaid && !nonePaid);
  const aggregateStatus = allPaid ? "Paid" : hasPartial ? "Partial" : "Pending";

  // Update inside a transaction, with the verified-record guard lifted
  const { updated: updatedRow } = await tx(async (c) => {
    // Allow updating a verified order (same as makerChecker admin path)
    await c.query("SELECT set_config('app.allow_verified_change', 'on', true)");

    const { rows: updated } = await c.query(
      `UPDATE orders
       SET receivers_data = $1::jsonb,
           payment_status = $2
       WHERE id = $3
       RETURNING *`,
      [JSON.stringify(recs), aggregateStatus, id]
    );

    await audit(c, {
      userId: req.user!.id,
      action: "update",
      table: "orders",
      recordId: id,
      oldData: orderRows[0],
      newData: updated[0],
      ip: req.ip
    });

    return { updated: updated[0] };
  });

  res.json({ record: updatedRow });
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



// =============== Received AED ===============

/**
 * @openapi
 * /records/received-aed:
 *   post:
 *     summary: Create a Received AED entry
 *     tags: [Records]
 *     responses:
 *       201:
 *         description: Entry created
 */
// Helper route: Agent Balance Calculation for Received AED
router.get("/received-aed/agent-balance", async (req, res) => {
  try {
    const agent = (req.query.agent as string) || (req.query.agent_customer as string) || "";
    const date = (req.query.date as string) || "";
    const excludeId = req.query.exclude_id ? parseInt(req.query.exclude_id as string) : null;

    if (!agent) {
      return res.json({ booked_aed: 0, already_received_aed: 0, pending_aed: 0 });
    }

    const cleanName = agent.replace(/\s*\([^)]*\)\s*$/, "").trim();
    const cifMatch = agent.match(/\(([^)]+)\)/);
    const cif = cifMatch ? cifMatch[1].trim() : "";

    // 1. Calculate Booked AED from orders
    const orderParams: any[] = [];
    const orderConds: string[] = [];

    if (date) {
      orderParams.push(date);
      orderConds.push("o.order_date = $" + orderParams.length);
    }

    if (cif) {
      orderParams.push(cif);
      const p1 = orderParams.length;
      orderParams.push("%" + cleanName + "%");
      const p2 = orderParams.length;
      orderConds.push("(p.cif_no = $" + p1 + " OR TRIM(p.first_name || \x27 \x27 || COALESCE(p.last_name, \x27\x27)) ILIKE $" + p2 + " OR o.party_id::text = $" + p1 + ")");
    } else {
      orderParams.push("%" + cleanName + "%");
      const p1 = orderParams.length;
      orderConds.push("(TRIM(p.first_name || \x27 \x27 || COALESCE(p.last_name, \x27\x27)) ILIKE $" + p1 + " OR o.party_id::text ILIKE $" + p1 + ")");
    }

    const orderWhere = orderConds.length ? "WHERE " + orderConds.join(" AND ") : "WHERE 1=0";
    const orderRes = await pool.query(
      "SELECT COALESCE(SUM(o.aed_amount), 0)::numeric as booked_aed FROM orders o LEFT JOIN parties p ON o.party_id = p.id " + orderWhere,
      orderParams
    );
    const bookedAed = parseFloat(orderRes.rows[0]?.booked_aed) || 0;

    // 2. Calculate Already Received AED from received_aed
    const recParams: any[] = [];
    const recConds: string[] = [];

    if (date) {
      recParams.push(date);
      recConds.push("ra.entry_date = $" + recParams.length);
    }

    recParams.push("%" + cleanName + "%");
    recConds.push("ra.agent_customer ILIKE $" + recParams.length);

    if (excludeId) {
      recParams.push(excludeId);
      recConds.push("ra.id != $" + recParams.length);
    }

    const recWhere = recConds.length ? "WHERE " + recConds.join(" AND ") : "WHERE 1=0";
    const recRes = await pool.query(
      "SELECT COALESCE(SUM(ra.aed_amount), 0)::numeric as received_aed FROM received_aed ra " + recWhere,
      recParams
    );
    const alreadyReceivedAed = parseFloat(recRes.rows[0]?.received_aed) || 0;
    const pendingAed = Math.max(0, Math.round((bookedAed - alreadyReceivedAed) * 100) / 100);

    res.json({
      agent,
      date,
      booked_aed: bookedAed,
      already_received_aed: alreadyReceivedAed,
      pending_aed: pendingAed,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to calculate agent balance", message: err.message });
  }
});
router.post("/received-aed", async (req, res) => {
  const body = z.object({
    aed_amount: z.number().positive(),
    collection_staff: z.string().min(1).optional(),
    mode_of_txn: z.string().min(1),
    cash_staff: z.string().optional(),
    remaining_amount: z.number().optional(),
    entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    agent_customer: z.string().optional().nullable(),
    utr_no: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
  }).parse(req.body);

  const entryDate = body.entry_date || new Date().toISOString().slice(0, 10);

  const { rows } = await pool.query(
    `INSERT INTO received_aed (aed_amount, collection_staff, mode_of_txn, cash_staff, remaining_amount, entry_date, created_by, agent_customer, utr_no, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      body.aed_amount,
      body.collection_staff || null,
      body.mode_of_txn,
      body.cash_staff || null,
      body.remaining_amount ?? null,
      entryDate,
      req.user!.id,
      body.agent_customer ? body.agent_customer.trim() : null,
      body.utr_no ? body.utr_no.trim() : null,
      body.description ? body.description.trim() : null
    ]
  );

  await audit(pool, {
    userId: req.user!.id,
    action: "create",
    table: "received_aed",
    recordId: rows[0].id,
    newData: rows[0],
    ip: req.ip,
  });

  res.status(201).json({ record: rows[0] });
});

/**
 * @openapi
 * /records/received-aed:
 *   get:
 *     summary: List Received AED entries
 *     tags: [Records]
 *     responses:
 *       200:
 *         description: Paginated list
 */
// =============== Pending AED Collection Report ===============
router.get("/reports/pending-aed", async (req, res) => {
  try {
    const fromDate = (req.query.from_date as string) || (req.query.fromDate as string) || "";
    const toDate = (req.query.to_date as string) || (req.query.toDate as string) || "";
    const date = (req.query.date as string) || "";
    const agentFilter = (req.query.agent as string) || "";
    const partyFilter = (req.query.party_id as string) || "";
    const statusFilter = (req.query.status as string) || "all";

    // 1. Fetch Orders aggregated by party
    const orderParams: any[] = [];
    const orderConds: string[] = [];

    if (fromDate && toDate) {
      orderParams.push(fromDate, toDate);
      orderConds.push("o.order_date >= $" + (orderParams.length - 1) + " AND o.order_date <= $" + orderParams.length);
    } else if (fromDate) {
      orderParams.push(fromDate);
      orderConds.push("o.order_date >= $" + orderParams.length);
    } else if (toDate) {
      orderParams.push(toDate);
      orderConds.push("o.order_date <= $" + orderParams.length);
    } else if (date) {
      orderParams.push(date);
      orderConds.push("o.order_date = $" + orderParams.length);
    }

    if (partyFilter) {
      orderParams.push(partyFilter);
      orderConds.push("o.party_id = $" + orderParams.length);
    }

    const orderWhere = orderConds.length ? "WHERE " + orderConds.join(" AND ") : "";
    const ordersRes = await pool.query(
      "SELECT o.party_id, " +
      "TRIM(COALESCE(p.first_name, \x27\x27) || \x27 \x27 || COALESCE(p.last_name, \x27\x27)) AS party_name, " +
      "p.cif_no, p.contact_number AS mobile_no, " +
      "COUNT(o.id)::int AS order_count, " +
      "COALESCE(SUM(o.aed_amount), 0)::numeric AS booked_aed, " +
      "COALESCE(SUM(o.inr_value), 0)::numeric AS booked_inr, " +
      "MIN(o.order_date)::text AS earliest_order_date, " +
      "MAX(o.order_date)::text AS latest_order_date " +
      "FROM orders o " +
      "LEFT JOIN parties p ON o.party_id = p.id " +
      orderWhere + " " +
      "GROUP BY o.party_id, p.first_name, p.last_name, p.cif_no, p.contact_number",
      orderParams
    );

    // 2. Fetch Received AED entries
    const recParams: any[] = [];
    const recConds: string[] = [];

    if (fromDate && toDate) {
      recParams.push(fromDate, toDate);
      recConds.push("ra.entry_date >= $" + (recParams.length - 1) + " AND ra.entry_date <= $" + recParams.length);
    } else if (fromDate) {
      recParams.push(fromDate);
      recConds.push("ra.entry_date >= $" + recParams.length);
    } else if (toDate) {
      recParams.push(toDate);
      recConds.push("ra.entry_date <= $" + recParams.length);
    } else if (date) {
      recParams.push(date);
      recConds.push("ra.entry_date = $" + recParams.length);
    }

    const recWhere = recConds.length ? "WHERE " + recConds.join(" AND ") : "";
    const recRes = await pool.query(
      "SELECT ra.id, ra.agent_customer, ra.aed_amount, ra.entry_date, ra.mode_of_txn, ra.utr_no, ra.cash_staff, ra.description " +
      "FROM received_aed ra " +
      recWhere,
      recParams
    );

    // 3. Complete list of parties for matching
    const allPartiesRes = await pool.query("SELECT id, cif_no, first_name, last_name, contact_number AS mobile_no FROM parties;");
    const partiesMap = new Map<string, any>();
    for (const p of allPartiesRes.rows) {
      partiesMap.set(String(p.id), p);
      if (p.cif_no) partiesMap.set(p.cif_no.trim().toLowerCase(), p);
    }

    // Map received amounts to party_id or cleaned name
    const partyReceivedMap = new Map<string, { total: number; entries: any[] }>();

    for (const r of recRes.rows) {
      const rawAgent = (r.agent_customer || "").trim();
      const aed = parseFloat(r.aed_amount) || 0;

      let matchedPartyId: string | null = null;
      if (rawAgent) {
        const cifMatch = rawAgent.match(/\(([^)]+)\)/);
        const cif = cifMatch ? cifMatch[1].trim().toLowerCase() : "";
        if (cif && partiesMap.has(cif)) {
          matchedPartyId = String(partiesMap.get(cif).id);
        } else {
          const cleanName = rawAgent.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
          for (const p of allPartiesRes.rows) {
            const fullName = (p.first_name || "" + " " + (p.last_name || "")).trim().toLowerCase();
            if (fullName === cleanName || (p.cif_no && p.cif_no.toLowerCase() === cleanName) || String(p.id) === cleanName) {
              matchedPartyId = String(p.id);
              break;
            }
          }
        }
      }

      const key = matchedPartyId || ("unmapped_" + (rawAgent || "unknown"));
      if (!partyReceivedMap.has(key)) {
        partyReceivedMap.set(key, { total: 0, entries: [] });
      }
      const item = partyReceivedMap.get(key)!;
      item.total += aed;
      item.entries.push(r);
    }

    // 4. Combine into rows
    const reportRows: any[] = [];
    const processedPartyIds = new Set<string>();

    for (const o of ordersRes.rows) {
      const pid = String(o.party_id);
      processedPartyIds.add(pid);

      const bookedAed = Math.round((parseFloat(o.booked_aed) || 0) * 100) / 100;
      const bookedInr = Math.round((parseFloat(o.booked_inr) || 0) * 100) / 100;
      const recData = partyReceivedMap.get(pid) || { total: 0, entries: [] };
      const receivedAed = Math.round(recData.total * 100) / 100;
      const pendingAed = Math.max(0, Math.round((bookedAed - receivedAed) * 100) / 100);
      const collectionRate = bookedAed > 0 ? Math.min(100, Math.round((receivedAed / bookedAed) * 1000) / 10) : (receivedAed > 0 ? 100 : 0);

      let status = "uncollected";
      if (pendingAed <= 0 && receivedAed >= bookedAed && bookedAed > 0) {
        status = "settled";
      } else if (receivedAed > 0 && pendingAed > 0) {
        status = "partial";
      } else if (bookedAed === 0 && receivedAed > 0) {
        status = "settled";
      }

      reportRows.push({
        party_id: o.party_id,
        party_name: o.party_name || "Unknown Agent",
        cif_no: o.cif_no || "",
        mobile_no: o.mobile_no || "",
        order_count: o.order_count || 0,
        booked_aed: bookedAed,
        booked_inr: bookedInr,
        received_aed: receivedAed,
        pending_aed: pendingAed,
        collection_rate_pct: collectionRate,
        status,
        earliest_order_date: o.earliest_order_date,
        latest_order_date: o.latest_order_date,
        received_entries_count: recData.entries.length,
      });
    }

    // Also include payments without orders in the period
    for (const [key, recData] of partyReceivedMap.entries()) {
      if (key.startsWith("unmapped_")) {
        const rawName = key.replace("unmapped_", "");
        reportRows.push({
          party_id: null,
          party_name: rawName || "Direct / Unmapped",
          cif_no: "",
          mobile_no: "",
          order_count: 0,
          booked_aed: 0,
          booked_inr: 0,
          received_aed: Math.round(recData.total * 100) / 100,
          pending_aed: 0,
          collection_rate_pct: 100,
          status: "settled",
          earliest_order_date: null,
          latest_order_date: null,
          received_entries_count: recData.entries.length,
        });
      } else if (!processedPartyIds.has(key)) {
        const p = partiesMap.get(key);
        reportRows.push({
          party_id: key,
          party_name: p ? (p.first_name || "" + " " + (p.last_name || "")).trim() : ("Party " + key),
          cif_no: p?.cif_no || "",
          mobile_no: p?.mobile_no || "",
          order_count: 0,
          booked_aed: 0,
          booked_inr: 0,
          received_aed: Math.round(recData.total * 100) / 100,
          pending_aed: 0,
          collection_rate_pct: 100,
          status: "settled",
          earliest_order_date: null,
          latest_order_date: null,
          received_entries_count: recData.entries.length,
        });
      }
    }

    // Filter by agent if provided
    let filtered = reportRows;
    if (agentFilter) {
      const q = agentFilter.toLowerCase();
      filtered = filtered.filter(r => 
        (r.party_name && r.party_name.toLowerCase().includes(q)) || 
        (r.cif_no && r.cif_no.toLowerCase().includes(q)) || 
        String(r.party_id).includes(q)
      );
    }

    // Filter by status
    if (statusFilter === "pending_only") {
      filtered = filtered.filter(r => r.pending_aed > 0);
    } else if (statusFilter === "partial") {
      filtered = filtered.filter(r => r.status === "partial");
    } else if (statusFilter === "uncollected") {
      filtered = filtered.filter(r => r.status === "uncollected");
    } else if (statusFilter === "settled") {
      filtered = filtered.filter(r => r.status === "settled");
    }

    filtered.sort((a, b) => b.pending_aed - a.pending_aed || b.booked_aed - a.booked_aed);

    const totalBookedAed = Math.round(reportRows.reduce((s, r) => s + r.booked_aed, 0) * 100) / 100;
    const totalReceivedAed = Math.round(reportRows.reduce((s, r) => s + r.received_aed, 0) * 100) / 100;
    const totalPendingAed = Math.max(0, Math.round(reportRows.reduce((s, r) => s + r.pending_aed, 0) * 100) / 100);
    const overallCollectionRate = totalBookedAed > 0 ? Math.min(100, Math.round((totalReceivedAed / totalBookedAed) * 1000) / 10) : 0;
    const pendingAgentsCount = reportRows.filter(r => r.pending_aed > 0).length;

    res.json({
      summary: {
        total_booked_aed: totalBookedAed,
        total_received_aed: totalReceivedAed,
        total_pending_aed: totalPendingAed,
        collection_rate_pct: overallCollectionRate,
        total_agents_count: reportRows.length,
        pending_agents_count: pendingAgentsCount,
      },
      filters: {
        from_date: fromDate,
        to_date: toDate,
        date: date,
        agent: agentFilter,
        status: statusFilter,
      },
      records: filtered,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to generate pending AED report", message: err.message });
  }
});

// Drill-down details for a specific party in Pending AED report
router.get("/reports/pending-aed/details", async (req, res) => {
  try {
    const partyId = req.query.party_id as string || "";
    const fromDate = (req.query.from_date as string) || "";
    const toDate = (req.query.to_date as string) || "";
    const date = (req.query.date as string) || "";

    if (!partyId) {
      return res.status(400).json({ error: "party_id is required" });
    }

    // Party info
    const partyRes = await pool.query("SELECT * FROM parties WHERE id = $1", [partyId]);
    const party = partyRes.rows[0];
    if (!party) {
      return res.status(404).json({ error: "Party not found" });
    }

    // Orders
    const orderParams: any[] = [partyId];
    const orderConds: string[] = ["o.party_id = $1"];
    if (fromDate && toDate) {
      orderParams.push(fromDate, toDate);
      orderConds.push("o.order_date >= $" + (orderParams.length - 1) + " AND o.order_date <= $" + orderParams.length);
    } else if (fromDate) {
      orderParams.push(fromDate);
      orderConds.push("o.order_date >= $" + orderParams.length);
    } else if (toDate) {
      orderParams.push(toDate);
      orderConds.push("o.order_date <= $" + orderParams.length);
    } else if (date) {
      orderParams.push(date);
      orderConds.push("o.order_date = $" + orderParams.length);
    }

    const ordersQuery = 
      "SELECT o.*, u.full_name as created_by_name " +
      "FROM orders o " +
      "LEFT JOIN users u ON o.created_by = u.id " +
      "WHERE " + orderConds.join(" AND ") + " " +
      "ORDER BY o.order_date DESC, o.created_at DESC";
    const ordersList = (await pool.query(ordersQuery, orderParams)).rows;

    // Received AED
    const cleanName = (party.first_name || "" + " " + (party.last_name || "")).trim();
    const recParams: any[] = ["%" + (party.cif_no || cleanName) + "%", "%" + cleanName + "%"];
    const recConds: string[] = ["(ra.agent_customer ILIKE $1 OR ra.agent_customer ILIKE $2)"];

    if (fromDate && toDate) {
      recParams.push(fromDate, toDate);
      recConds.push("ra.entry_date >= $" + (recParams.length - 1) + " AND ra.entry_date <= $" + recParams.length);
    } else if (fromDate) {
      recParams.push(fromDate);
      recConds.push("ra.entry_date >= $" + recParams.length);
    } else if (toDate) {
      recParams.push(toDate);
      recConds.push("ra.entry_date <= $" + recParams.length);
    } else if (date) {
      recParams.push(date);
      recConds.push("ra.entry_date = $" + recParams.length);
    }

    const recQuery = 
      "SELECT ra.*, u.full_name as created_by_name " +
      "FROM received_aed ra " +
      "LEFT JOIN users u ON ra.created_by = u.id " +
      "WHERE " + recConds.join(" AND ") + " " +
      "ORDER BY ra.entry_date DESC, ra.created_at DESC";
    const recList = (await pool.query(recQuery, recParams)).rows;

    const bookedAed = ordersList.reduce((s: number, o: any) => s + (parseFloat(o.aed_amount) || 0), 0);
    const receivedAed = recList.reduce((s: number, r: any) => s + (parseFloat(r.aed_amount) || 0), 0);
    const pendingAed = Math.max(0, Math.round((bookedAed - receivedAed) * 100) / 100);

    res.json({
      party: {
        id: party.id,
        cif_no: party.cif_no,
        name: cleanName,
        mobile_no: party.contact_number || party.mobile_no || "",
      },
      booked_aed: Math.round(bookedAed * 100) / 100,
      received_aed: Math.round(receivedAed * 100) / 100,
      pending_aed: pendingAed,
      orders: ordersList,
      received_entries: recList,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to load details", message: err.message });
  }
});

router.get("/received-aed", async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
  const offset = (page - 1) * limit;

  const dateFilter = (req.query.date as string) || null;
  const modeFilter = (req.query.mode_of_txn as string) || null;
  const agentFilter = (req.query.agent_customer as string) || (req.query.agent as string) || null;

  const conditions: string[] = [];
  const params: any[] = [];

  if (dateFilter) {
    params.push(dateFilter);
    conditions.push(`ra.entry_date = $${params.length}`);
  }
  if (modeFilter) {
    params.push(modeFilter);
    conditions.push(`ra.mode_of_txn = $${params.length}`);
  }
  if (agentFilter) {
    params.push(`%${agentFilter}%`);
    conditions.push(`ra.agent_customer ILIKE $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRes = await pool.query(
    `SELECT count(*)::int AS total, COALESCE(SUM(ra.aed_amount), 0)::numeric AS total_aed_sum FROM received_aed ra ${where}`,
    params
  );
  const total = countRes.rows[0].total;
  const totalAedSum = parseFloat(countRes.rows[0].total_aed_sum) || 0;

  const dataParams = [...params, limit, offset];
  const { rows } = await pool.query(
    `SELECT ra.*, u.full_name AS created_by_name
     FROM received_aed ra
     LEFT JOIN users u ON u.id = ra.created_by
     ${where}
     ORDER BY ra.entry_date DESC, ra.created_at DESC
     LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    dataParams
  );

  res.json({ records: rows, total, totalAedSum, page, limit });
});

router.get("/cost-rate", async (req, res) => {
  const dateStr = (req.query.date as string) || new Date().toISOString().slice(0, 10);

  const rateRes = await pool.query(
    "SELECT * FROM daily_rates WHERE rate_date = $1 LIMIT 1",
    [dateStr]
  );
  const savedRate = rateRes.rows[0] || null;

  const aggRes = await pool.query(
    "SELECT COUNT(*)::int as order_count, COALESCE(SUM(aed_amount), 0)::numeric as total_aed, COALESCE(SUM(inr_value), 0)::numeric as total_inr FROM orders WHERE order_date = $1",
    [dateStr]
  );
  const agg = aggRes.rows[0];
  const orderCount = parseInt(agg.order_count) || 0;
  const totalAed = parseFloat(agg.total_aed) || 0;
  const totalInr = parseFloat(agg.total_inr) || 0;
  const avgSaleRate = totalAed > 0 ? (totalInr / totalAed) : 0;

  const costRate = savedRate ? parseFloat(savedRate.cost_rate) : null;
  let profitInr = 0;
  let profitAed = 0;

  if (costRate && totalAed > 0) {
    profitInr = (totalAed * costRate) - totalInr;
    profitAed = costRate > 0 ? profitInr / costRate : 0;
  }

  res.json({
    date: dateStr,
    cost_rate: costRate,
    sale_rate: savedRate && savedRate.sale_rate ? parseFloat(savedRate.sale_rate) : avgSaleRate,
    has_saved_rate: !!savedRate,
    summary: {
      order_count: orderCount,
      total_aed: totalAed,
      total_inr: totalInr,
      avg_sale_rate: avgSaleRate,
      profit_inr: profitInr,
      profit_aed: profitAed
    }
  });
});

router.post("/cost-rate", async (req, res) => {
  const bodySchema = z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format (YYYY-MM-DD)"),
    cost_rate: z.number().positive("Cost rate must be greater than 0")
  });

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid data", details: parsed.error.issues });
  }

  const { date: dateStr, cost_rate } = parsed.data;
  const mf = makerFields(req.user!);

  const aggRes = await pool.query(
    "SELECT COUNT(*)::int as order_count, COALESCE(SUM(aed_amount), 0)::numeric as total_aed, COALESCE(SUM(inr_value), 0)::numeric as total_inr FROM orders WHERE order_date = $1",
    [dateStr]
  );
  const totalAed = parseFloat(aggRes.rows[0].total_aed) || 0;
  const totalInr = parseFloat(aggRes.rows[0].total_inr) || 0;
  const orderCount = parseInt(aggRes.rows[0].order_count) || 0;
  const avgSaleRate = totalAed > 0 ? (totalInr / totalAed) : null;

  const { upsertRateRes, updateOrdersRes } = await tx(async (c) => {
    await c.query("SELECT set_config('app.allow_verified_change', 'on', true)");

    const upsertRateRes = await c.query(
      `INSERT INTO daily_rates (rate_date, cost_rate, sale_rate, status, created_by, verified_by, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (rate_date)
       DO UPDATE SET 
         cost_rate = EXCLUDED.cost_rate,
         sale_rate = COALESCE(EXCLUDED.sale_rate, daily_rates.sale_rate),
         status = EXCLUDED.status,
         verified_by = EXCLUDED.verified_by,
         verified_at = EXCLUDED.verified_at
       RETURNING *`,
      [dateStr, cost_rate, avgSaleRate, mf.status, mf.created_by, mf.verified_by, mf.verified_at]
    );

    const updateOrdersRes = await c.query(
      "UPDATE orders SET cost_rate = $1, expected_profit_inr = ROUND(($1 * aed_amount) - inr_value, 2) WHERE order_date = $2 RETURNING id",
      [cost_rate, dateStr]
    );

    return { upsertRateRes, updateOrdersRes };
  });

  const profitInr = (totalAed * cost_rate) - totalInr;
  const profitAed = cost_rate > 0 ? profitInr / cost_rate : 0;

  await audit(pool, {
    userId: req.user!.id,
    action: "upsert_cost_rate",
    table: "daily_rates",
    recordId: upsertRateRes.rows[0].id,
    newData: { date: dateStr, cost_rate, updated_orders_count: updateOrdersRes.rowCount },
    ip: req.ip
  });

  res.json({
    success: true,
    message: "Cost rate updated successfully",
    rate: upsertRateRes.rows[0],
    updated_orders_count: updateOrdersRes.rowCount,
    summary: {
      order_count: orderCount,
      total_aed: totalAed,
      total_inr: totalInr,
      avg_sale_rate: avgSaleRate || 0,
      profit_inr: profitInr,
      profit_aed: profitAed
    }
  });
});

router.get("/beneficiaries", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT DISTINCT
        TRIM(client_name) AS client_name,
        TRIM(account_number) AS account_number,
        UPPER(TRIM(ifsc_code)) AS ifsc_code,
        TRIM(bank_name) AS bank_name,
        TRIM(branch_name) AS branch_name,
        TRIM(servicer) AS servicer,
        party_id
      FROM (
        SELECT 
          COALESCE(r->>'clientName', o.receiver_name) AS client_name,
          COALESCE(r->>'accountNumber', o.receiver_account) AS account_number,
          COALESCE(r->>'ifscCode', o.receiver_ifsc) AS ifsc_code,
          COALESCE(r->>'bankName', o.receiver_bank) AS bank_name,
          COALESCE(r->>'branchName', o.receiver_branch) AS branch_name,
          r->>'servicer' AS servicer,
          o.party_id
        FROM orders o
        LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.receivers_data) = 'array' THEN o.receivers_data ELSE '[]'::jsonb END) r ON true
        WHERE COALESCE(r->>'clientName', o.receiver_name) IS NOT NULL 
           OR COALESCE(r->>'accountNumber', o.receiver_account) IS NOT NULL
        UNION
        SELECT 
          name AS client_name,
          account_no AS account_number,
          ifsc AS ifsc_code,
          bank_name,
          NULL AS branch_name,
          NULL AS servicer,
          party_id
        FROM receivers
        UNION
        SELECT
          beneficiary_name AS client_name,
          account_number,
          ifsc_code,
          bank_name,
          branch_name,
          NULL AS servicer,
          NULL AS party_id
        FROM credit_entries
        WHERE beneficiary_name IS NOT NULL OR account_number IS NOT NULL
      ) sub
      WHERE (client_name IS NOT NULL AND client_name <> '')
         OR (account_number IS NOT NULL AND account_number <> '')
      ORDER BY client_name ASC NULLS LAST
    `);
    res.json({ beneficiaries: rows });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch beneficiaries", message: err.message });
  }
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
