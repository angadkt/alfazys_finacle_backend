import { Router } from "express";
import { z } from "zod";
import { pool, tx } from "../db";
import { requireAuth } from "../auth/middleware";
import { audit } from "../audit";

const router = Router();
router.use(requireAuth);

// =========================================================================
// 1. SERVICERS MANAGEMENT
// =========================================================================

/**
 * GET /payouts/servicers
 * Returns all active servicers with computed real-time multi-bucket wallet balances.
 */
router.get("/servicers", async (req, res) => {
  try {
    const servicersRes = await pool.query(
      `SELECT s.*, u.full_name as created_by_name,
              pd.id as photo_doc_id,
              pd.mime_type as photo_mime_type,
              CASE WHEN pd.file_data IS NOT NULL THEN encode(pd.file_data, 'base64') ELSE NULL END as photo_base64
       FROM servicers s
       LEFT JOIN users u ON s.created_by = u.id
       LEFT JOIN LATERAL (
         SELECT id, mime_type, file_data
         FROM party_documents
         WHERE party_id = s.party_id AND doc_type = 'photo'
         ORDER BY id DESC
         LIMIT 1
       ) pd ON true
       ORDER BY s.created_at DESC`
    );

    const txnsRes = await pool.query(
      `SELECT 
         servicer_id,
         wallet_type,
         direction,
         txn_type,
         COALESCE(SUM(amount), 0)::numeric as total_amount,
         COALESCE(SUM(commission_amount), 0)::numeric as total_commission,
         commission_settled
       FROM servicer_transactions
       WHERE servicer_id IS NOT NULL AND bounced = false
       GROUP BY servicer_id, wallet_type, direction, txn_type, commission_settled`
    );

    // Group balances per servicer
    const balances = new Map<string, {
      bank_in: number;
      bank_out: number;
      cash_in: number;
      cash_out: number;
      reimbursements: number;
      accrued_commission: number;
      settled_commission: number;
      total_payouts_count: number;
      total_payouts_amount: number;
    }>();

    for (const r of txnsRes.rows) {
      const sid = String(r.servicer_id);
      if (!balances.has(sid)) {
        balances.set(sid, {
          bank_in: 0,
          bank_out: 0,
          cash_in: 0,
          cash_out: 0,
          reimbursements: 0,
          accrued_commission: 0,
          settled_commission: 0,
          total_payouts_count: 0,
          total_payouts_amount: 0,
        });
      }
      const b = balances.get(sid)!;
      const amt = parseFloat(r.total_amount) || 0;
      const comm = parseFloat(r.total_commission) || 0;

      if (r.wallet_type === "bank") {
        if (r.direction === "in") b.bank_in += amt;
        else if (r.direction === "out") b.bank_out += amt;
      } else if (r.wallet_type === "cash") {
        if (r.direction === "in") b.cash_in += amt;
        else if (r.direction === "out") b.cash_out += amt;
      }

      if (r.txn_type === "reimbursement") {
        b.reimbursements += amt;
      }

      if (r.commission_settled) {
        b.settled_commission += comm;
      } else {
        b.accrued_commission += comm;
      }

      if (r.txn_type === "payout_debit") {
        b.total_payouts_amount += amt;
      }
    }

    // Also get count of payouts
    const countsRes = await pool.query(
      `SELECT servicer_id, COUNT(*)::int as count
       FROM servicer_transactions
       WHERE txn_type = 'payout_debit' AND bounced = false AND servicer_id IS NOT NULL
       GROUP BY servicer_id`
    );
    const payoutCounts = new Map<string, number>();
    for (const c of countsRes.rows) {
      payoutCounts.set(String(c.servicer_id), parseInt(c.count) || 0);
    }

    const records = servicersRes.rows.map((s) => {
      const sid = String(s.id);
      const b = balances.get(sid) || {
        bank_in: 0,
        bank_out: 0,
        cash_in: 0,
        cash_out: 0,
        reimbursements: 0,
        accrued_commission: 0,
        settled_commission: 0,
        total_payouts_count: 0,
        total_payouts_amount: 0,
      };

      const bankBalance = Math.round((b.bank_in - b.bank_out) * 100) / 100;
      const cashBalance = Math.round((b.cash_in - b.cash_out) * 100) / 100;
      const totalFloat = Math.round((bankBalance + cashBalance) * 100) / 100;

      let photoUrl: string | null = null;
      if (s.photo_base64) {
        photoUrl = `data:${s.photo_mime_type || "image/jpeg"};base64,${s.photo_base64}`;
      } else if (s.photo_doc_id && s.party_id) {
        photoUrl = `/cif/${s.party_id}/documents/${s.photo_doc_id}`;
      }

      return {
        id: s.id,
        party_id: s.party_id || null,
        cif_no: s.cif_no || "",
        servicer_code: s.servicer_code,
        name: s.name,
        phone: s.phone || "",
        city: s.city || "",
        branch: s.branch || "INDIA",
        bank_name: s.bank_name || "",
        account_no: s.account_no || "",
        ifsc_code: s.ifsc_code || "",
        bank_accounts: s.bank_accounts || [],
        commission_rate: parseFloat(s.commission_rate) || 0,
        status: s.status,
        created_at: s.created_at,
        created_by_name: s.created_by_name || "Admin",
        photo_doc_id: s.photo_doc_id || null,
        photo_url: photoUrl,
        wallet: {
          bank_balance: bankBalance,
          cash_balance: cashBalance,
          total_float: totalFloat,
          reimbursements_due: Math.round(b.reimbursements * 100) / 100,
          accrued_commission: Math.round(b.accrued_commission * 100) / 100,
          settled_commission: Math.round(b.settled_commission * 100) / 100,
          total_payouts_count: payoutCounts.get(sid) || 0,
          total_payouts_amount: Math.round(b.total_payouts_amount * 100) / 100,
        },
      };
    });

    res.json({ servicers: records });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch servicers", message: err.message });
  }
});

/**
 * GET /payouts/eligible-cifs
 * Returns verified parties where CIF Type = SERVICER (cif_type_id = 5)
 */
router.get("/eligible-cifs", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT 
         p.id,
         p.cif_no,
         p.first_name,
         p.last_name,
         p.short_name,
         p.contact_number,
         p.indian_number,
         p.status,
         p.created_at,
         COALESCE(pa.city, '') as city,
         COALESCE(pa.country, '') as country,
         s.id as existing_servicer_id,
         s.servicer_code as existing_servicer_code,
         pd.id as photo_doc_id,
         pd.mime_type as photo_mime_type,
         CASE WHEN pd.file_data IS NOT NULL THEN encode(pd.file_data, 'base64') ELSE NULL END as photo_base64
       FROM parties p
       LEFT JOIN party_addresses pa ON pa.party_id = p.id AND pa.address_type = 'PERMANENT'
       LEFT JOIN servicers s ON s.party_id = p.id
       LEFT JOIN LATERAL (
         SELECT id, mime_type, file_data
         FROM party_documents
         WHERE party_id = p.id AND doc_type = 'photo'
         ORDER BY id DESC
         LIMIT 1
       ) pd ON true
       WHERE p.cif_type_id = 5 AND p.status = 'verified' AND s.id IS NULL
       ORDER BY p.id DESC`
    );

    const cifsWithPhoto = rows.map((c: any) => {
      let photoUrl: string | null = null;
      if (c.photo_base64) {
        photoUrl = `data:${c.photo_mime_type || "image/jpeg"};base64,${c.photo_base64}`;
      } else if (c.photo_doc_id) {
        photoUrl = `/cif/${c.id}/documents/${c.photo_doc_id}`;
      }
      return {
        ...c,
        photo_url: photoUrl,
      };
    });

    res.json({ cifs: cifsWithPhoto });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to load eligible servicer CIFs", message: err.message });
  }
});

/**
 * POST /payouts/servicers
 * Create / Open a new Servicer Wallet Account (supports linking to verified CIF)
 */
router.post("/servicers", async (req, res) => {
  try {
    const schema = z.object({
      party_id: z.union([z.string(), z.number()]).optional(),
      name: z.string().optional(),
      phone: z.string().optional().default(""),
      city: z.string().optional().default(""),
      branch: z.enum(["INDIA", "UAE"]).optional().default("INDIA"),
      bank_name: z.string().optional().default(""),
      account_no: z.string().optional().default(""),
      ifsc_code: z.string().optional().default(""),
      bank_accounts: z.array(z.any()).optional().default([]),
      commission_rate: z.number().min(0).max(10).optional().default(0),
      status: z.enum(["active", "inactive", "suspended"]).default("active"),
    });

    const body = schema.parse(req.body);

    let finalName = (body.name || "").trim();
    let finalPhone = body.phone.trim();
    let finalCity = body.city.trim();
    let finalCifNo: string | null = null;
    let finalPartyId: string | null = null;

    if (body.party_id) {
      finalPartyId = String(body.party_id);
      const partyRes = await pool.query(
        `SELECT p.*, COALESCE(pa.city, '') as city
         FROM parties p
         LEFT JOIN party_addresses pa ON pa.party_id = p.id AND pa.address_type = 'PERMANENT'
         WHERE p.id = $1`,
        [finalPartyId]
      );
      if (partyRes.rows.length > 0) {
        const p = partyRes.rows[0];
        finalCifNo = p.cif_no || null;
        if (!finalName) {
          finalName = [p.first_name, p.last_name].filter(Boolean).join(" ");
        }
        if (!finalPhone) {
          finalPhone = (p.contact_number || p.indian_number || "").trim();
        }
        if (!finalCity) {
          finalCity = (p.city || "").trim();
        }
      }
    }

    if (!finalName) {
      return res.status(400).json({ error: "Servicer name is required" });
    }

    const branch = (body.branch || "INDIA").toUpperCase();

    let finalAccountNo = body.account_no.trim();
    if (!finalAccountNo) {
      if (branch === "UAE") {
        const seqRes = await pool.query("SELECT nextval('servicer_acc_uae_seq')::text as acc");
        finalAccountNo = `00971 1010 ${seqRes.rows[0].acc.padStart(5, "0")}`;
      } else {
        const seqRes = await pool.query("SELECT nextval('servicer_acc_india_seq')::text as acc");
        finalAccountNo = `0091 1010 ${seqRes.rows[0].acc.padStart(6, "0")}`;
      }
    }
    let finalIfscCode = body.ifsc_code.trim().toUpperCase();
    if (!finalIfscCode) {
      finalIfscCode = branch === "UAE" ? "FNCL0000971" : "FNCL0000091";
    }

    let finalBankName = body.bank_name.trim();
    if (!finalBankName) {
      finalBankName = branch === "UAE" ? "Infazys Finacle - UAE Branch" : "Infazys Finacle - India Branch";
    }

    const { rows } = await pool.query(
      `INSERT INTO servicers (party_id, cif_no, name, phone, city, branch, bank_name, account_no, ifsc_code, bank_accounts, commission_rate, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        finalPartyId,
        finalCifNo,
        finalName,
        finalPhone,
        finalCity,
        branch,
        finalBankName,
        finalAccountNo,
        finalIfscCode,
        JSON.stringify(body.bank_accounts || []),
        body.commission_rate ?? 0,
        body.status,
        req.user!.id,
      ]
    );

    await audit(pool, {
      userId: req.user!.id,
      action: "create_servicer",
      table: "servicers",
      recordId: rows[0].id,
      newData: rows[0],
      ip: req.ip,
    });

    res.status(201).json({ success: true, servicer: rows[0] });
  } catch (err: any) {
    res.status(400).json({ error: "Failed to create servicer", message: err.message });
  }
});

/**
 * PATCH /payouts/servicers/:id
 * Update an existing Servicer Profile
 */
router.patch("/servicers/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const schema = z.object({
      name: z.string().min(1).optional(),
      phone: z.string().optional(),
      city: z.string().optional(),
      branch: z.enum(["INDIA", "UAE"]).optional(),
      bank_name: z.string().optional(),
      account_no: z.string().optional(),
      ifsc_code: z.string().optional(),
      bank_accounts: z.array(z.any()).optional(),
      commission_rate: z.number().min(0).max(10).optional(),
      status: z.enum(["active", "inactive", "suspended"]).optional(),
    });

    const body = schema.parse(req.body);
    const updates: string[] = [];
    const values: any[] = [];

    if (body.name !== undefined) { values.push(body.name.trim()); updates.push(`name = $${values.length}`); }
    if (body.phone !== undefined) { values.push(body.phone.trim()); updates.push(`phone = $${values.length}`); }
    if (body.city !== undefined) { values.push(body.city.trim()); updates.push(`city = $${values.length}`); }
    if (body.branch !== undefined) { 
      values.push(body.branch); 
      updates.push(`branch = $${values.length}`); 
      if (body.ifsc_code === undefined) {
        const autoIfsc = body.branch === "UAE" ? "FNCL0000971" : "FNCL0000091";
        values.push(autoIfsc);
        updates.push(`ifsc_code = $${values.length}`);
      }
    }
    if (body.bank_name !== undefined) { values.push(body.bank_name.trim()); updates.push(`bank_name = $${values.length}`); }
    if (body.account_no !== undefined) { values.push(body.account_no.trim()); updates.push(`account_no = $${values.length}`); }
    if (body.ifsc_code !== undefined) { values.push(body.ifsc_code.trim().toUpperCase()); updates.push(`ifsc_code = $${values.length}`); }
    if (body.bank_accounts !== undefined) { values.push(JSON.stringify(body.bank_accounts)); updates.push(`bank_accounts = $${values.length}`); }
    if (body.commission_rate !== undefined) { values.push(body.commission_rate); updates.push(`commission_rate = $${values.length}`); }
    if (body.status !== undefined) { values.push(body.status); updates.push(`status = $${values.length}`); }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields provided to update" });
    }

    values.push(id);
    const { rows } = await pool.query(
      `UPDATE servicers SET ${updates.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Servicer not found" });
    }

    res.json({ success: true, servicer: rows[0] });
  } catch (err: any) {
    res.status(400).json({ error: "Failed to update servicer", message: err.message });
  }
});

// =========================================================================
// 2. WALLET FLOAT MOVEMENTS (CREDIT, CONVERSION, COMMISSION SETTLE)
// =========================================================================

/**
 * POST /payouts/servicers/:id/credit
 * Top up / Add float to a Servicer's Wallet (Bank or Cash)
 */
router.post("/servicers/:id/credit", async (req, res) => {
  try {
    const servicerId = req.params.id;
    const schema = z.object({
      amount: z.number().positive("Amount must be greater than 0"),
      wallet_type: z.enum(["bank", "cash"]),
      payment_mode: z.string().default("bank_transfer"),
      utr_number: z.string().optional(),
      note: z.string().optional(),
      entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format YYYY-MM-DD").default(() => new Date().toISOString().slice(0, 10)),
    });

    const body = schema.parse(req.body);

    const servicerCheck = await pool.query("SELECT * FROM servicers WHERE id = $1", [servicerId]);
    if (servicerCheck.rows.length === 0) {
      return res.status(404).json({ error: "Servicer not found" });
    }
    const servicer = servicerCheck.rows[0];

    // Duplicate UTR check if provided
    if (body.utr_number && body.utr_number.trim()) {
      const dup = await pool.query(
        "SELECT txn_no FROM servicer_transactions WHERE utr_number = $1 AND bounced = false LIMIT 1",
        [body.utr_number.trim()]
      );
      if (dup.rows.length > 0) {
        return res.status(400).json({ error: `UTR number ${body.utr_number} is already recorded in transaction ${dup.rows[0].txn_no}` });
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO servicer_transactions (
         servicer_id, channel, txn_type, direction, wallet_type, amount,
         payment_mode, utr_number, note, entry_date, created_by
       ) VALUES ($1, 'servicer', 'float_credit', 'in', $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        servicerId,
        body.wallet_type,
        body.amount,
        body.payment_mode,
        body.utr_number?.trim() || null,
        body.note?.trim() || `Float top-up for ${servicer.name}`,
        body.entry_date,
        req.user!.id,
      ]
    );

    await audit(pool, {
      userId: req.user!.id,
      action: "servicer_float_credit",
      table: "servicer_transactions",
      recordId: rows[0].id,
      newData: rows[0],
      ip: req.ip,
    });

    res.status(201).json({ success: true, transaction: rows[0] });
  } catch (err: any) {
    res.status(400).json({ error: "Failed to record float credit", message: err.message });
  }
});

/**
 * POST /payouts/servicers/:id/convert
 * Internal Float Conversion (ATM Cash Withdrawal / Deposit: Bank <-> Cash)
 */
router.post("/servicers/:id/convert", async (req, res) => {
  try {
    const servicerId = req.params.id;
    const schema = z.object({
      amount: z.number().positive("Amount must be greater than 0"),
      from_wallet: z.enum(["bank", "cash"]),
      to_wallet: z.enum(["bank", "cash"]),
      note: z.string().optional(),
      entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => new Date().toISOString().slice(0, 10)),
    });

    const body = schema.parse(req.body);
    if (body.from_wallet === body.to_wallet) {
      return res.status(400).json({ error: "Source and destination wallets must be different" });
    }

    const servicerCheck = await pool.query("SELECT * FROM servicers WHERE id = $1", [servicerId]);
    if (servicerCheck.rows.length === 0) {
      return res.status(404).json({ error: "Servicer not found" });
    }

    const result = await tx(async (c) => {
      // 1. Deduct from source wallet
      const outRes = await c.query(
        `INSERT INTO servicer_transactions (
           servicer_id, channel, txn_type, direction, wallet_type, amount,
           payment_mode, note, entry_date, created_by
         ) VALUES ($1, 'servicer', 'conversion', 'out', $2, $3, 'internal_transfer', $4, $5, $6)
         RETURNING *`,
        [
          servicerId,
          body.from_wallet,
          body.amount,
          body.note || `Float conversion from ${body.from_wallet} to ${body.to_wallet}`,
          body.entry_date,
          req.user!.id,
        ]
      );

      // 2. Add to destination wallet
      const inRes = await c.query(
        `INSERT INTO servicer_transactions (
           servicer_id, channel, txn_type, direction, wallet_type, amount,
           payment_mode, note, entry_date, created_by
         ) VALUES ($1, 'servicer', 'conversion', 'in', $2, $3, 'internal_transfer', $4, $5, $6)
         RETURNING *`,
        [
          servicerId,
          body.to_wallet,
          body.amount,
          body.note || `Float conversion from ${body.from_wallet} to ${body.to_wallet}`,
          body.entry_date,
          req.user!.id,
        ]
      );

      return { out: outRes.rows[0], in: inRes.rows[0] };
    });

    res.json({ success: true, conversion: result });
  } catch (err: any) {
    res.status(400).json({ error: "Failed to perform float conversion", message: err.message });
  }
});

/**
 * POST /payouts/servicers/inter-transfer
 * Inter-Servicer Working Float Transfer (Directly move float between two servicers)
 */
router.post("/servicers/inter-transfer", async (req, res) => {
  try {
    const schema = z.object({
      from_servicer_id: z.union([z.string(), z.number()]),
      to_servicer_id: z.union([z.string(), z.number()]),
      from_wallet: z.enum(["bank", "cash"]).default("bank"),
      to_wallet: z.enum(["bank", "cash"]).default("bank"),
      amount: z.number().positive("Amount must be greater than 0"),
      utr_number: z.string().optional(),
      note: z.string().optional(),
      entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => new Date().toISOString().slice(0, 10)),
    });

    const body = schema.parse(req.body);
    const fromId = String(body.from_servicer_id);
    const toId = String(body.to_servicer_id);

    if (fromId === toId) {
      return res.status(400).json({ error: "Source and destination servicers must be different" });
    }

    const { rows: matchedServicers } = await pool.query(
      "SELECT id, name, servicer_code FROM servicers WHERE id IN ($1, $2)",
      [fromId, toId]
    );

    const fromServicer = matchedServicers.find((s: any) => String(s.id) === fromId);
    const toServicer = matchedServicers.find((s: any) => String(s.id) === toId);

    if (!fromServicer || !toServicer) {
      return res.status(404).json({ error: "One or both servicers not found" });
    }

    const result = await tx(async (c) => {
      const outNote = [
        `Inter-Servicer Float Transfer TO [${toServicer.servicer_code}] ${toServicer.name}`,
        body.utr_number ? `UTR: ${body.utr_number.trim()}` : "",
        body.note ? body.note.trim() : ""
      ].filter(Boolean).join(" • ");

      const inNote = [
        `Inter-Servicer Float Transfer FROM [${fromServicer.servicer_code}] ${fromServicer.name}`,
        body.utr_number ? `UTR: ${body.utr_number.trim()}` : "",
        body.note ? body.note.trim() : ""
      ].filter(Boolean).join(" • ");

      // 1. Deduct from source servicer
      const outRes = await c.query(
        `INSERT INTO servicer_transactions (
           servicer_id, channel, txn_type, direction, wallet_type, amount,
           payment_mode, utr_number, note, entry_date, created_by
         ) VALUES ($1, 'servicer', 'conversion', 'out', $2, $3, 'inter_servicer_transfer', $4, $5, $6, $7)
         RETURNING *`,
        [
          fromId,
          body.from_wallet,
          body.amount,
          body.utr_number ? body.utr_number.trim() : null,
          outNote,
          body.entry_date,
          req.user!.id,
        ]
      );

      // 2. Add to destination servicer
      const inRes = await c.query(
        `INSERT INTO servicer_transactions (
           servicer_id, channel, txn_type, direction, wallet_type, amount,
           payment_mode, utr_number, note, entry_date, created_by
         ) VALUES ($1, 'servicer', 'conversion', 'in', $2, $3, 'inter_servicer_transfer', $4, $5, $6, $7)
         RETURNING *`,
        [
          toId,
          body.to_wallet,
          body.amount,
          body.utr_number ? body.utr_number.trim() : null,
          inNote,
          body.entry_date,
          req.user!.id,
        ]
      );

      return { out: outRes.rows[0], in: inRes.rows[0] };
    });

    res.json({
      success: true,
      message: `Successfully transferred ₹${body.amount.toLocaleString("en-IN")} from ${fromServicer.name} to ${toServicer.name}`,
      transfer: result,
    });
  } catch (err: any) {
    res.status(400).json({ error: "Failed to execute inter-servicer float transfer", message: err.message });
  }
});

/**
 * POST /payouts/servicers/:id/settle-commission
 * Mark accrued commission as paid/settled
 */
router.post("/servicers/:id/settle-commission", async (req, res) => {
  try {
    const servicerId = req.params.id;
    const { rows: pendingComms } = await pool.query(
      `SELECT COALESCE(SUM(commission_amount), 0)::numeric as total_commission, COUNT(*)::int as count
       FROM servicer_transactions
       WHERE servicer_id = $1 AND commission_settled = false AND bounced = false AND commission_amount > 0`,
      [servicerId]
    );

    const totalToSettle = parseFloat(pendingComms[0]?.total_commission) || 0;
    if (totalToSettle <= 0) {
      return res.status(400).json({ error: "No accrued commission to settle for this servicer" });
    }

    const { rowCount } = await pool.query(
      `UPDATE servicer_transactions
       SET commission_settled = true
       WHERE servicer_id = $1 AND commission_settled = false AND bounced = false AND commission_amount > 0`,
      [servicerId]
    );

    res.json({
      success: true,
      settled_amount: totalToSettle,
      transactions_updated: rowCount,
      message: `Successfully settled ₹ ${totalToSettle.toLocaleString('en-IN', { minimumFractionDigits: 2 })} commission across ${rowCount} transactions.`,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to settle commission", message: err.message });
  }
});

/**
 * GET /payouts/statement
 * Unified or single-servicer passbook ledger with date, servicer, type, and search filters
 */
router.get("/statement", async (req, res) => {
  try {
    const servicerId = (req.query.servicer_id as string) || "";
    const fromDate = (req.query.from_date as string) || (req.query.fromDate as string) || "";
    const toDate = (req.query.to_date as string) || (req.query.toDate as string) || "";
    const txnType = (req.query.txn_type as string) || "all";
    const search = (req.query.search as string) || "";

    const params: any[] = [];
    const conds: string[] = [];

    if (servicerId && servicerId !== "all") {
      params.push(servicerId);
      conds.push(`st.servicer_id = $${params.length}`);
    }

    if (fromDate && toDate) {
      params.push(fromDate, toDate);
      conds.push(`st.entry_date >= $${params.length - 1} AND st.entry_date <= $${params.length}`);
    } else if (fromDate) {
      params.push(fromDate);
      conds.push(`st.entry_date >= $${params.length}`);
    } else if (toDate) {
      params.push(toDate);
      conds.push(`st.entry_date <= $${params.length}`);
    }

    if (txnType && txnType !== "all") {
      params.push(txnType);
      conds.push(`st.txn_type = $${params.length}`);
    }

    if (search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      conds.push(`(
        LOWER(COALESCE(st.utr_number, '')) LIKE $${params.length} OR
        LOWER(COALESCE(st.txn_no, '')) LIKE $${params.length} OR
        LOWER(COALESCE(st.beneficiary_name, '')) LIKE $${params.length} OR
        LOWER(COALESCE(st.note, '')) LIKE $${params.length} OR
        LOWER(COALESCE(s.name, '')) LIKE $${params.length} OR
        LOWER(COALESCE(o.order_no, '')) LIKE $${params.length}
      )`);
    }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    const { rows } = await pool.query(
      `SELECT st.*, u.full_name as created_by_name, o.order_no, s.name as servicer_name, s.servicer_code
       FROM servicer_transactions st
       LEFT JOIN users u ON st.created_by = u.id
       LEFT JOIN orders o ON st.order_id = o.id
       LEFT JOIN servicers s ON st.servicer_id = s.id
       ${where}
       ORDER BY st.entry_date DESC, st.created_at DESC
       LIMIT 300`,
      params
    );

    res.json({ transactions: rows, total: rows.length });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to load statement", message: err.message });
  }
});

router.get("/servicers/:id/statement", async (req, res) => {
  try {
    const servicerId = req.params.id;
    const fromDate = (req.query.from_date as string) || (req.query.fromDate as string) || "";
    const toDate = (req.query.to_date as string) || (req.query.toDate as string) || "";
    const txnType = (req.query.txn_type as string) || "all";
    const search = (req.query.search as string) || "";

    const params: any[] = [servicerId];
    const conds: string[] = ["st.servicer_id = $1"];

    if (fromDate && toDate) {
      params.push(fromDate, toDate);
      conds.push(`st.entry_date >= $${params.length - 1} AND st.entry_date <= $${params.length}`);
    } else if (fromDate) {
      params.push(fromDate);
      conds.push(`st.entry_date >= $${params.length}`);
    } else if (toDate) {
      params.push(toDate);
      conds.push(`st.entry_date <= $${params.length}`);
    }

    if (txnType && txnType !== "all") {
      params.push(txnType);
      conds.push(`st.txn_type = $${params.length}`);
    }

    if (search.trim()) {
      params.push(`%${search.trim().toLowerCase()}%`);
      conds.push(`(
        LOWER(COALESCE(st.utr_number, '')) LIKE $${params.length} OR
        LOWER(COALESCE(st.txn_no, '')) LIKE $${params.length} OR
        LOWER(COALESCE(st.beneficiary_name, '')) LIKE $${params.length} OR
        LOWER(COALESCE(st.note, '')) LIKE $${params.length} OR
        LOWER(COALESCE(o.order_no, '')) LIKE $${params.length}
      )`);
    }

    const where = `WHERE ${conds.join(" AND ")}`;

    const { rows } = await pool.query(
      `SELECT st.*, u.full_name as created_by_name, o.order_no, s.name as servicer_name, s.servicer_code
       FROM servicer_transactions st
       LEFT JOIN users u ON st.created_by = u.id
       LEFT JOIN orders o ON st.order_id = o.id
       LEFT JOIN servicers s ON st.servicer_id = s.id
       ${where}
       ORDER BY st.entry_date DESC, st.created_at DESC
       LIMIT 300`,
      params
    );

    res.json({ transactions: rows, total: rows.length });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to load statement", message: err.message });
  }
});

// =========================================================================
// 3. DISPATCH QUEUE & PAYOUT EXECUTION (DEBIT ENTRY)
// =========================================================================

/**
 * GET /payouts/dispatch-queue
 * Queue of all booked order receivers awaiting payout in India
 */
router.get("/dispatch-queue", async (req, res) => {
  try {
    const fromDate = (req.query.from_date as string) || (req.query.fromDate as string) || "";
    const toDate = (req.query.to_date as string) || (req.query.toDate as string) || "";
    const servicerId = (req.query.servicer_id as string) || (req.query.servicerId as string) || "all";
    const paymentMode = (req.query.payment_mode as string) || "all";
    const searchQuery = (req.query.search as string) || "";

    const params: any[] = [];
    const conds: string[] = ["st.txn_type = 'payout_debit'"];

    if (servicerId && servicerId !== "all") {
      params.push(servicerId);
      conds.push(`st.servicer_id = $${params.length}`);
    }

    if (fromDate && toDate) {
      params.push(fromDate, toDate);
      conds.push(`st.entry_date >= $${params.length - 1} AND st.entry_date <= $${params.length}`);
    } else if (fromDate) {
      params.push(fromDate);
      conds.push(`st.entry_date >= $${params.length}`);
    } else if (toDate) {
      params.push(toDate);
      conds.push(`st.entry_date <= $${params.length}`);
    }

    if (paymentMode && paymentMode !== "all") {
      params.push(paymentMode);
      conds.push(`st.payment_mode = $${params.length}`);
    }

    if (searchQuery.trim()) {
      params.push(`%${searchQuery.trim().toLowerCase()}%`);
      conds.push(`(
        LOWER(COALESCE(st.beneficiary_name, '')) LIKE $${params.length} OR
        LOWER(COALESCE(st.beneficiary_account, '')) LIKE $${params.length} OR
        LOWER(COALESCE(st.beneficiary_ifsc, '')) LIKE $${params.length} OR
        LOWER(COALESCE(st.beneficiary_bank, '')) LIKE $${params.length} OR
        LOWER(COALESCE(st.beneficiary_branch, '')) LIKE $${params.length} OR
        LOWER(COALESCE(st.utr_number, '')) LIKE $${params.length} OR
        LOWER(COALESCE(st.txn_no, '')) LIKE $${params.length} OR
        LOWER(COALESCE(s.name, '')) LIKE $${params.length} OR
        LOWER(COALESCE(s.servicer_code, '')) LIKE $${params.length}
      )`);
    }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    const { rows: debits } = await pool.query(
      `SELECT st.*, 
              s.name as servicer_name, s.servicer_code, s.cif_no, s.account_no as servicer_account_no,
              u.full_name as created_by_name
       FROM servicer_transactions st
       LEFT JOIN servicers s ON st.servicer_id = s.id
       LEFT JOIN users u ON st.created_by = u.id
       ${where}
       ORDER BY st.entry_date DESC, st.created_at DESC
       LIMIT 300`,
      params
    );

    // Aggregate summary metrics: Float Credited vs Beneficiary Debited
    const sumCreditedRes = await pool.query(
      "SELECT COALESCE(SUM(amount), 0)::numeric as total_credited FROM servicer_transactions WHERE txn_type = 'float_credit' AND bounced = false"
    );
    const sumDebitedRes = await pool.query(
      "SELECT COALESCE(SUM(amount), 0)::numeric as total_debited, COUNT(*)::int as debits_count FROM servicer_transactions WHERE txn_type = 'payout_debit' AND bounced = false"
    );

    const totalCredited = parseFloat(sumCreditedRes.rows[0]?.total_credited || "0") || 0;
    const totalDebited = parseFloat(sumDebitedRes.rows[0]?.total_debited || "0") || 0;
    const netAvailable = Math.round((totalCredited - totalDebited) * 100) / 100;
    const debitsCount = parseInt(sumDebitedRes.rows[0]?.debits_count || "0") || 0;

    res.json({
      summary: {
        total_credited: totalCredited,
        total_debited: totalDebited,
        net_available: netAvailable,
        total_debits: debitsCount,
      },
      records: debits.map((d: any) => ({
        id: d.id,
        txn_no: d.txn_no,
        entry_date: d.entry_date,
        servicer_id: d.servicer_id,
        servicer_name: d.servicer_name || (d.channel === "direct" ? "Company Direct" : "Unassigned"),
        servicer_code: d.servicer_code || "",
        cif_no: d.cif_no || "",
        servicer_account_no: d.servicer_account_no || "",
        channel: d.channel,
        wallet_type: d.wallet_type,
        beneficiary_name: d.beneficiary_name || "Beneficiary",
        account_number: d.beneficiary_account || "",
        ifsc_code: d.beneficiary_ifsc || "",
        bank_name: d.beneficiary_bank || "",
        branch_name: d.beneficiary_branch || "",
        amount: parseFloat(d.amount) || 0,
        payment_mode: d.payment_mode,
        utr_number: d.utr_number || "",
        note: d.note || "",
        bounced: d.bounced,
        bounced_reason: d.bounced_reason || "",
        created_at: d.created_at,
        created_by_name: d.created_by_name || "Admin",
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to generate debit entries queue", message: err.message });
  }
});

/**
 * POST /payouts/dispatch
 * Record Direct Beneficiary Payout (Debit Entry)
 * Debits servicer float or marks as direct company payout
 */
router.post("/dispatch", async (req, res) => {
  try {
    const schema = z.object({
      channel: z.enum(["servicer", "direct"]).default("servicer"),
      servicer_id: z.coerce.number().nullable().optional(),
      wallet_type: z.enum(["bank", "cash", "direct"]).default("bank"),
      beneficiary_name: z.string().min(1, "Beneficiary name is required"),
      beneficiary_account: z.string().optional().default(""),
      beneficiary_bank: z.string().optional().default(""),
      beneficiary_branch: z.string().optional().default(""),
      beneficiary_ifsc: z.string().optional().default(""),
      actual_paid_amount: z.number().positive("Payout amount must be greater than 0"),
      payment_mode: z.string().default("bank_transfer"),
      utr_number: z.string().min(1, "UTR / Transaction reference is required"),
      proof_file_key: z.string().optional(),
      note: z.string().optional(),
      entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => new Date().toISOString().slice(0, 10)),
    });

    const body = schema.parse(req.body);

    // 1. Check duplicate UTR
    const dupCheck = await pool.query(
      "SELECT txn_no, utr_number FROM servicer_transactions WHERE utr_number = $1 AND bounced = false LIMIT 1",
      [body.utr_number.trim()]
    );
    if (dupCheck.rows.length > 0) {
      return res.status(400).json({
        error: `Duplicate UTR Reference: '${body.utr_number}' was already recorded in transaction ${dupCheck.rows[0].txn_no}`,
      });
    }

    // 2. Fetch Servicer if channel is servicer
    let servicer: any = null;
    let commissionRate = 0;
    let commissionAmount = 0;

    if (body.channel === "servicer") {
      if (!body.servicer_id) {
        return res.status(400).json({ error: "Please select a servicer to execute this payout" });
      }
      const sRes = await pool.query("SELECT * FROM servicers WHERE id = $1", [body.servicer_id]);
      if (sRes.rows.length === 0) {
        return res.status(404).json({ error: "Selected servicer not found" });
      }
      servicer = sRes.rows[0];
      commissionRate = parseFloat(servicer.commission_rate) || 0;
      if (commissionRate > 0) {
        commissionAmount = Math.round(body.actual_paid_amount * (commissionRate / 100) * 100) / 100;
      }
    }

    // 3. Insert into servicer_transactions
    const { rows } = await pool.query(
      `INSERT INTO servicer_transactions (
         servicer_id, channel, txn_type, direction, wallet_type, amount,
         beneficiary_name, beneficiary_account, beneficiary_bank, beneficiary_branch, beneficiary_ifsc,
         commission_rate, commission_amount, commission_settled,
         payment_mode, utr_number, proof_file_key, note, entry_date, created_by
       ) VALUES (
         $1, $2, 'payout_debit', 'out', $3, $4,
         $5, $6, $7, $8, $9,
         $10, $11, false,
         $12, $13, $14, $15, $16, $17
       ) RETURNING *`,
      [
        body.channel === "servicer" ? body.servicer_id : null,
        body.channel,
        body.channel === "direct" ? "direct" : body.wallet_type,
        body.actual_paid_amount,
        body.beneficiary_name.trim(),
        body.beneficiary_account.trim(),
        body.beneficiary_bank.trim(),
        body.beneficiary_branch.trim(),
        body.beneficiary_ifsc.trim().toUpperCase(),
        commissionRate,
        commissionAmount,
        body.payment_mode,
        body.utr_number.trim(),
        body.proof_file_key || null,
        body.note?.trim() || null,
        body.entry_date,
        req.user!.id,
      ]
    );

    await audit(pool, {
      userId: req.user!.id,
      action: "beneficiary_debit_entry",
      table: "servicer_transactions",
      recordId: rows[0].id,
      newData: rows[0],
      ip: req.ip,
    });

    res.status(201).json({
      success: true,
      transaction: rows[0],
      message: `Successfully recorded debit entry of ₹${body.actual_paid_amount.toLocaleString("en-IN")} to ${body.beneficiary_name}`,
    });
  } catch (err: any) {
    res.status(400).json({ error: "Failed to record debit entry", message: err.message });
  }
});

/**
 * POST /payouts/transactions/:id/bounce
 * Mark a payout as bounced/reversed
 */
router.post("/transactions/:id/bounce", async (req, res) => {
  try {
    const txnId = req.params.id;
    const { reason } = req.body;

    const result = await tx(async (c) => {
      await c.query("SELECT set_config('app.allow_verified_change', 'on', true)");
      const txnRes = await c.query("SELECT * FROM servicer_transactions WHERE id = $1 FOR UPDATE", [txnId]);
      if (txnRes.rows.length === 0) throw new Error("Transaction not found");
      const txn = txnRes.rows[0];

      if (txn.bounced) {
        throw new Error("Transaction is already marked as bounced");
      }
      if (txn.txn_type !== "payout_debit") {
        throw new Error("Only payout debit transactions can be bounced");
      }

      // Mark transaction bounced
      await c.query(
        `UPDATE servicer_transactions 
         SET bounced = true, bounced_at = now(), bounced_reason = $1
         WHERE id = $2`,
        [reason || "Bank rejection / account bounce", txnId]
      );

      // Revert receiver status in order
      if (txn.order_id) {
        const ordRes = await c.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [txn.order_id]);
        if (ordRes.rows.length > 0) {
          const order = ordRes.rows[0];
          let recs: any[] = Array.isArray(order.receivers_data) ? order.receivers_data : [];
          const idx = txn.receiver_index ?? 0;
          if (recs[idx]) {
            recs[idx].payment_status = "Pending";
            recs[idx].paid_amount = Math.max(0, (recs[idx].paid_amount || 0) - txn.amount);
            recs[idx].bounced_notice = `Bounced on ${new Date().toLocaleDateString('en-CA')}: ${reason || "Reversed by Bank"}`;
            await c.query(
              "UPDATE orders SET receivers_data = $1, payment_status = 'Pending' WHERE id = $2",
              [JSON.stringify(recs), txn.order_id]
            );
          }
        }
      }

      return { txn_id: txnId, amount_reversed: txn.amount };
    });

    res.json({
      success: true,
      message: `Transaction ${txnId} marked as bounced. Funds restored to servicer float and beneficiary reset to Pending.`,
      result,
    });
  } catch (err: any) {
    res.status(400).json({ error: "Failed to bounce transaction", message: err.message });
  }
});

export default router;
