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
      `SELECT s.*, u.full_name as created_by_name
       FROM servicers s
       LEFT JOIN users u ON s.created_by = u.id
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

      return {
        id: s.id,
        servicer_code: s.servicer_code,
        name: s.name,
        phone: s.phone || "",
        city: s.city || "",
        bank_name: s.bank_name || "",
        account_no: s.account_no || "",
        ifsc_code: s.ifsc_code || "",
        commission_rate: parseFloat(s.commission_rate) || 0,
        status: s.status,
        created_at: s.created_at,
        created_by_name: s.created_by_name || "Admin",
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
 * POST /payouts/servicers
 * Create a new Servicer Account
 */
router.post("/servicers", async (req, res) => {
  try {
    const schema = z.object({
      name: z.string().min(2, "Name is required"),
      phone: z.string().optional().default(""),
      city: z.string().optional().default(""),
      bank_name: z.string().optional().default(""),
      account_no: z.string().optional().default(""),
      ifsc_code: z.string().optional().default(""),
      commission_rate: z.number().min(0).max(10).default(0.25),
      status: z.enum(["active", "inactive", "suspended"]).default("active"),
    });

    const body = schema.parse(req.body);

    const { rows } = await pool.query(
      `INSERT INTO servicers (name, phone, city, bank_name, account_no, ifsc_code, commission_rate, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        body.name.trim(),
        body.phone.trim(),
        body.city.trim(),
        body.bank_name.trim(),
        body.account_no.trim(),
        body.ifsc_code.trim().toUpperCase(),
        body.commission_rate,
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
      bank_name: z.string().optional(),
      account_no: z.string().optional(),
      ifsc_code: z.string().optional(),
      commission_rate: z.number().min(0).max(10).optional(),
      status: z.enum(["active", "inactive", "suspended"]).optional(),
    });

    const body = schema.parse(req.body);
    const updates: string[] = [];
    const values: any[] = [];

    if (body.name !== undefined) { values.push(body.name.trim()); updates.push(`name = $${values.length}`); }
    if (body.phone !== undefined) { values.push(body.phone.trim()); updates.push(`phone = $${values.length}`); }
    if (body.city !== undefined) { values.push(body.city.trim()); updates.push(`city = $${values.length}`); }
    if (body.bank_name !== undefined) { values.push(body.bank_name.trim()); updates.push(`bank_name = $${values.length}`); }
    if (body.account_no !== undefined) { values.push(body.account_no.trim()); updates.push(`account_no = $${values.length}`); }
    if (body.ifsc_code !== undefined) { values.push(body.ifsc_code.trim().toUpperCase()); updates.push(`ifsc_code = $${values.length}`); }
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
    const fromDate = (req.query.from_date as string) || "";
    const toDate = (req.query.to_date as string) || "";
    const statusFilter = (req.query.status as string) || "all";
    const searchQuery = (req.query.search as string) || "";

    const params: any[] = [];
    const conds: string[] = [];

    if (fromDate && toDate) {
      params.push(fromDate, toDate);
      conds.push(`o.order_date >= $${params.length - 1} AND o.order_date <= $${params.length}`);
    } else if (fromDate) {
      params.push(fromDate);
      conds.push(`o.order_date >= $${params.length}`);
    } else if (toDate) {
      params.push(toDate);
      conds.push(`o.order_date <= $${params.length}`);
    }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    const { rows: orders } = await pool.query(
      `SELECT o.id, o.order_no, o.order_date, o.aed_amount, o.inr_value, o.payment_status as overall_payment_status,
              o.receivers_data, o.receiver_name, o.receiver_account, o.receiver_ifsc, o.receiver_bank, o.receiver_branch,
              o.party_id, TRIM(COALESCE(p.first_name, '') || ' ' || COALESCE(p.last_name, '')) AS party_name,
              p.cif_no
       FROM orders o
       LEFT JOIN parties p ON o.party_id = p.id
       ${where}
       ORDER BY o.order_date DESC, o.id DESC`,
      params
    );

    // Expand receivers from JSONB
    const queueRows: any[] = [];

    for (const ord of orders) {
      let recs: any[] = [];
      if (Array.isArray(ord.receivers_data) && ord.receivers_data.length > 0) {
        recs = ord.receivers_data;
      } else {
        recs = [
          {
            clientName: ord.receiver_name || "Beneficiary",
            accountNumber: ord.receiver_account || "",
            ifscCode: ord.receiver_ifsc || "",
            bankName: ord.receiver_bank || "",
            branchName: ord.receiver_branch || "",
            orderAmount: ord.inr_value || 0,
            payment_status: ord.overall_payment_status || "Pending",
          },
        ];
      }

      recs.forEach((r, idx) => {
        const orderAmount = parseFloat(String(r.orderAmount || 0).replace(/,/g, "")) || 0;
        const paidAmount = parseFloat(String(r.paid_amount || (r.payment_status === "Paid" ? orderAmount : 0))) || 0;
        const balanceDue = Math.max(0, Math.round((orderAmount - paidAmount) * 100) / 100);
        const pStatus = (r.payment_status || "Pending").trim();

        queueRows.push({
          order_id: ord.id,
          order_no: ord.order_no,
          order_date: ord.order_date,
          party_id: ord.party_id,
          party_name: ord.party_name || "Unknown Agent",
          cif_no: ord.cif_no || "",
          receiver_index: idx,
          beneficiary_name: r.clientName || r.receiver_name || "Beneficiary",
          account_number: r.accountNumber || r.receiver_account || "",
          ifsc_code: r.ifscCode || r.receiver_ifsc || "",
          bank_name: r.bankName || r.receiver_bank || "",
          branch_name: r.branchName || r.receiver_branch || "",
          servicer_name: r.servicer || r.servicer_name || "",
          servicer_id: r.servicer_id || null,
          order_amount: orderAmount,
          paid_amount: paidAmount,
          balance_due: balanceDue,
          payment_status: pStatus,
          last_utr: r.utr_number || r.last_utr || "",
          paid_at: r.paid_at || null,
          payout_channel: r.payout_channel || "servicer",
          variance_amount: r.variance_amount || 0,
          variance_reason: r.variance_reason || "",
        });
      });
    }

    // Filter by search
    let filtered = queueRows;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      filtered = filtered.filter((r) =>
        r.beneficiary_name.toLowerCase().includes(q) ||
        r.account_number.toLowerCase().includes(q) ||
        r.ifsc_code.toLowerCase().includes(q) ||
        r.party_name.toLowerCase().includes(q) ||
        r.cif_no.toLowerCase().includes(q) ||
        r.order_no.toLowerCase().includes(q)
      );
    }

    // Filter by status
    if (statusFilter === "pending_only") {
      filtered = filtered.filter((r) => r.payment_status.toLowerCase() === "pending" || r.payment_status.toLowerCase() === "partial");
    } else if (statusFilter === "partial") {
      filtered = filtered.filter((r) => r.payment_status.toLowerCase() === "partial");
    } else if (statusFilter === "paid") {
      filtered = filtered.filter((r) => r.payment_status.toLowerCase() === "paid");
    }

    // Aggregate summary metrics
    const totalObligation = Math.round(queueRows.reduce((s, r) => s + r.order_amount, 0) * 100) / 100;
    const totalPaid = Math.round(queueRows.reduce((s, r) => s + r.paid_amount, 0) * 100) / 100;
    const totalUncleared = Math.max(0, Math.round(queueRows.reduce((s, r) => s + r.balance_due, 0) * 100) / 100);
    const pendingCount = queueRows.filter((r) => r.payment_status.toLowerCase() === "pending" || r.payment_status.toLowerCase() === "partial").length;
    const paidCount = queueRows.filter((r) => r.payment_status.toLowerCase() === "paid").length;

    res.json({
      summary: {
        total_obligation: totalObligation,
        total_paid: totalPaid,
        total_uncleared: totalUncleared,
        pending_count: pendingCount,
        paid_count: paidCount,
        total_beneficiaries: queueRows.length,
      },
      records: filtered,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to generate dispatch queue", message: err.message });
  }
});

/**
 * POST /payouts/dispatch
 * Execute Beneficiary Payout (Debit Entry)
 * Supports both Servicer Payout and Direct Company Payout
 * Handles Case 1 (Limit Shortfall) and Case 2 (CDM pocket top-up)
 */
router.post("/dispatch", async (req, res) => {
  try {
    const schema = z.object({
      order_id: z.coerce.number().positive(),
      receiver_index: z.coerce.number().min(0).default(0),
      channel: z.enum(["servicer", "direct"]).default("servicer"),
      servicer_id: z.coerce.number().nullable().optional(),
      wallet_type: z.enum(["bank", "cash", "direct"]).default("bank"),
      actual_paid_amount: z.number().positive("Actual paid amount must be greater than 0"),
      expected_amount: z.number().positive(),
      payment_mode: z.string().default("bank_transfer"),
      utr_number: z.string().min(1, "UTR / Transaction reference is required"),
      proof_file_key: z.string().optional(),
      note: z.string().optional(),
      entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => new Date().toISOString().slice(0, 10)),
      variance_reason: z.string().optional(),
    });

    const body = schema.parse(req.body);

    // 1. Check duplicate UTR
    const dupCheck = await pool.query(
      "SELECT txn_no, order_id FROM servicer_transactions WHERE utr_number = $1 AND bounced = false LIMIT 1",
      [body.utr_number.trim()]
    );
    if (dupCheck.rows.length > 0) {
      return res.status(400).json({
        error: `Duplicate UTR Reference: '${body.utr_number}' was already used in transaction ${dupCheck.rows[0].txn_no}`,
      });
    }

    // 2. Fetch Servicer if channel is servicer
    let servicer: any = null;
    let commissionRate = 0;
    let commissionAmount = 0;

    if (body.channel === "servicer") {
      if (!body.servicer_id) {
        return res.status(400).json({ error: "Servicer must be selected for servicer dispatch" });
      }
      const sRes = await pool.query("SELECT * FROM servicers WHERE id = $1", [body.servicer_id]);
      if (sRes.rows.length === 0) {
        return res.status(404).json({ error: "Selected servicer not found" });
      }
      servicer = sRes.rows[0];
      commissionRate = parseFloat(servicer.commission_rate) || 0;
      commissionAmount = Math.round(body.actual_paid_amount * (commissionRate / 100) * 100) / 100;
    }

    // 3. Execute atomic transaction
    const result = await tx(async (c) => {
      await c.query("SELECT set_config('app.allow_verified_change', 'on', true)");
      // Fetch order
      const ordRes = await c.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [body.order_id]);
      if (ordRes.rows.length === 0) {
        throw new Error("Order not found");
      }
      const order = ordRes.rows[0];

      let recs: any[] = [];
      if (Array.isArray(order.receivers_data) && order.receivers_data.length > 0) {
        recs = order.receivers_data;
      } else {
        recs = [
          {
            clientName: order.receiver_name,
            accountNumber: order.receiver_account,
            ifscCode: order.receiver_ifsc,
            bankName: order.receiver_bank,
            branchName: order.receiver_branch,
            orderAmount: order.inr_value,
            payment_status: order.payment_status || "Pending",
          },
        ];
      }

      if (body.receiver_index >= recs.length) {
        throw new Error(`Receiver index ${body.receiver_index} out of bounds`);
      }

      const rec = recs[body.receiver_index];
      const previousPaid = parseFloat(String(rec.paid_amount || 0)) || 0;
      const newCumulativePaid = Math.round((previousPaid + body.actual_paid_amount) * 100) / 100;
      const targetAmount = parseFloat(String(rec.orderAmount || body.expected_amount)) || body.expected_amount;

      // Status determination
      const variance = Math.round((body.actual_paid_amount - body.expected_amount) * 100) / 100;
      let newReceiverStatus = "Paid";
      if (newCumulativePaid < targetAmount) {
        newReceiverStatus = "Partial"; // Case 1: Shortfall / Limit
      } else {
        newReceiverStatus = "Paid"; // Case 2 or Full Settlement
      }

      // Record servicer debit transaction
      const debitRes = await c.query(
        `INSERT INTO servicer_transactions (
           servicer_id, channel, txn_type, direction, wallet_type, amount,
           order_id, receiver_index, beneficiary_name, beneficiary_account, beneficiary_bank, beneficiary_ifsc,
           expected_amount, variance_amount, variance_reason,
           commission_rate, commission_amount, commission_settled,
           payment_mode, utr_number, proof_file_key, note, entry_date, created_by
         ) VALUES (
           $1, $2, 'payout_debit', 'out', $3, $4,
           $5, $6, $7, $8, $9, $10,
           $11, $12, $13,
           $14, $15, false,
           $16, $17, $18, $19, $20, $21
         ) RETURNING *`,
        [
          body.channel === "servicer" ? body.servicer_id : null,
          body.channel,
          body.channel === "direct" ? "direct" : body.wallet_type,
          body.actual_paid_amount,
          body.order_id,
          body.receiver_index,
          rec.clientName || rec.receiver_name || "Beneficiary",
          rec.accountNumber || rec.receiver_account || "",
          rec.bankName || rec.receiver_bank || "",
          rec.ifscCode || rec.receiver_ifsc || "",
          body.expected_amount,
          variance,
          body.variance_reason || (variance > 0 ? "CDM Pocket Top-up" : variance < 0 ? "Account Limit Shortfall" : "Exact Payout"),
          commissionRate,
          commissionAmount,
          body.payment_mode,
          body.utr_number.trim(),
          body.proof_file_key || null,
          body.note || null,
          body.entry_date,
          req.user!.id,
        ]
      );

      // Case 2: If servicer paid extra from pocket (variance > 0), auto-generate reimbursement credit
      let reimbRes: any = null;
      if (body.channel === "servicer" && variance > 0) {
        reimbRes = await c.query(
          `INSERT INTO servicer_transactions (
             servicer_id, channel, txn_type, direction, wallet_type, amount,
             order_id, receiver_index, note, entry_date, created_by
           ) VALUES ($1, 'servicer', 'reimbursement', 'in', 'cash', $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            body.servicer_id,
            variance,
            body.order_id,
            body.receiver_index,
            `Pocket Top-up Reimbursement for Order ${order.order_no} (${body.variance_reason || "CDM note denomination"})`,
            body.entry_date,
            req.user!.id,
          ]
        );
      }

      // Update receiver inside receivers_data
      rec.paid_amount = newCumulativePaid;
      rec.payment_status = newReceiverStatus;
      rec.utr_number = body.utr_number.trim();
      rec.servicer_id = body.servicer_id || null;
      rec.servicer_name = servicer ? servicer.name : "Direct";
      rec.payout_channel = body.channel;
      rec.paid_at = new Date().toISOString();
      rec.variance_amount = variance;
      rec.variance_reason = body.variance_reason || "";

      recs[body.receiver_index] = rec;

      // Check overall order payment status
      const allPaid = recs.every((r) => (r.payment_status || "").toLowerCase() === "paid");
      const anyPartial = recs.some((r) => (r.payment_status || "").toLowerCase() === "partial" || ((r.paid_amount || 0) > 0 && (r.paid_amount || 0) < (r.orderAmount || 0)));
      const overallStatus = allPaid ? "Paid" : anyPartial ? "Partial" : "Pending";

      await c.query(
        "UPDATE orders SET receivers_data = $1, payment_status = $2 WHERE id = $3",
        [JSON.stringify(recs), overallStatus, body.order_id]
      );

      return {
        debit: debitRes.rows[0],
        reimbursement: reimbRes ? reimbRes.rows[0] : null,
        new_receiver_status: newReceiverStatus,
        overall_order_status: overallStatus,
      };
    });

    await audit(pool, {
      userId: req.user!.id,
      action: "payout_dispatch",
      table: "servicer_transactions",
      recordId: result.debit.id,
      newData: result.debit,
      ip: req.ip,
    });

    res.status(201).json({
      success: true,
      result,
      message: `Payout of ₹ ${body.actual_paid_amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })} recorded successfully. Status: ${result.new_receiver_status}.`,
    });
  } catch (err: any) {
    res.status(400).json({ error: "Failed to process payout dispatch", message: err.message });
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
