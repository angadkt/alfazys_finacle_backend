import type { PoolClient } from "pg";
import { audit } from "./audit";
import { AuthUser, hasAccess } from "./auth/permissions";
import { pool, tx } from "./db";
import { HttpError } from "./errors";
import { TABLES, TableConfig } from "./registry";

export type FieldValue = any;
export type FieldData = Record<string, FieldValue>;

/** Table names are only trusted after passing through this function. */
function cfg(table: string): TableConfig {
  const c = Object.prototype.hasOwnProperty.call(TABLES, table) ? TABLES[table] : undefined;
  if (!c) throw new HttpError(404, "Unknown table");
  return c;
}

async function lockRecord(c: PoolClient, table: string, id: string) {
  cfg(table);
  const { rows } = await c.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows[0]) throw new HttpError(404, "Record not found");
  return rows[0];
}

/** Lets the backend change a VERIFIED row. Only used after the admin approves. */
const allowVerifiedChange = (c: PoolClient) =>
  c.query("SELECT set_config('app.allow_verified_change', 'on', true)");

function checkFields(table: string, data: FieldData) {
  const allowed = new Set(cfg(table).editable);
  const keys = Object.keys(data).filter(k => !k.startsWith("_"));
  if (keys.length === 0 && Object.keys(data).length === 0) throw new HttpError(400, "No fields to change");
  const bad = keys.filter((k) => !allowed.has(k));
  if (bad.length) throw new HttpError(400, `These fields cannot be changed: ${bad.join(", ")}`);
}

async function updateFields(c: PoolClient, table: string, id: string, data: FieldData, extra: FieldData = {}) {
  const all = { ...data, ...extra };
  const cols = Object.keys(all).filter(k => !k.startsWith("_"));
  if (cols.length === 0) {
    const { rows } = await c.query(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    return rows[0]; // Return the existing record if only virtual fields were passed
  }
  const sets = cols.map((col, i) => `${col} = $${i + 2}`).join(", ");
  const { rows } = await c.query(`UPDATE ${table} SET ${sets} WHERE id = $1 RETURNING *`, [id, ...cols.map((k) => all[k])]);
  return rows[0];
}

/**
 * Use this when creating a new record (later steps).
 * Super admin records are verified at once. Staff records start as pending.
 */
export function makerFields(user: AuthUser) {
  const admin = user.role === "admin";
  return {
    status: admin ? "verified" : "pending",
    created_by: user.id,
    verified_by: admin ? user.id : null,
    verified_at: admin ? new Date().toISOString() : null,
  };
}

// ---------- Edit ----------
export async function editRecord(user: AuthUser, table: string, id: string, data: FieldData, ip?: string) {
  const conf = cfg(table);
  if (!hasAccess(user, conf.module, "edit")) throw new HttpError(403, "You do not have edit access to this module");
  checkFields(table, data);

  return tx(async (c) => {
    const old = await lockRecord(c, table, id);

    // Super admin: the change is applied now.
    if (user.role === "admin") {
      await allowVerifiedChange(c);
      const updatedDb = await updateFields(c, table, id, data);
      const updated = { ...updatedDb, ...data }; // Merge virtual fields
      if (old.status === "verified") await conf.afterEdit?.(c, old, updated);
      await audit(c, { userId: user.id, action: "update", table, recordId: id, oldData: old, newData: updated, ip });
      return { applied: true, record: updated };
    }

    // Staff, record already verified: save the change as a request. The old values stay active.
    if (old.status === "verified") {
      const open = await c.query(
        "SELECT 1 FROM record_changes WHERE table_name = $1 AND record_id = $2 AND status = 'pending'", [table, id]);
      if (open.rowCount) throw new HttpError(409, "A change for this record is already waiting for the admin");
      const { rows } = await c.query(
        `INSERT INTO record_changes (table_name, record_id, kind, proposed, requested_by)
         VALUES ($1, $2, 'edit', $3, $4) RETURNING *`, [table, id, JSON.stringify(data), user.id]);
      await audit(c, { userId: user.id, action: "request_edit", table, recordId: id, oldData: old, newData: data, ip });
      return { applied: false, change: rows[0] };
    }

    // Staff, record is pending or rejected: only the person who made it can fix it.
    if (String(old.created_by) !== user.id) throw new HttpError(403, "You can only edit your own records");
    const updated = await updateFields(c, table, id, data, { status: "pending", rejection_reason: null, verified_by: null, verified_at: null });
    await audit(c, { userId: user.id, action: "update", table, recordId: id, oldData: old, newData: updated, ip });
    return { applied: true, record: updated };
  });
}

// ---------- Delete ----------
async function deleteNow(c: PoolClient, conf: TableConfig, table: string, id: string, old: any) {
  await allowVerifiedChange(c);
  await conf.cleanupOnDelete?.(c, id);
  await c.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  void old;
}

export async function deleteOrRequest(user: AuthUser, table: string, id: string, ip?: string) {
  const conf = cfg(table);
  if (!hasAccess(user, conf.module, "edit")) throw new HttpError(403, "You do not have edit access to this module");

  return tx(async (c) => {
    const old = await lockRecord(c, table, id);

    if (user.role === "admin") {
      await deleteNow(c, conf, table, id, old);
      await audit(c, { userId: user.id, action: "delete", table, recordId: id, oldData: old, ip });
      return { applied: true };
    }

    // Staff cannot delete. They can only ask the admin.
    const open = await c.query(
      "SELECT 1 FROM record_changes WHERE table_name = $1 AND record_id = $2 AND status = 'pending'", [table, id]);
    if (open.rowCount) throw new HttpError(409, "A request for this record is already waiting for the admin");
    const { rows } = await c.query(
      `INSERT INTO record_changes (table_name, record_id, kind, requested_by)
       VALUES ($1, $2, 'delete', $3) RETURNING *`, [table, id, user.id]);
    await audit(c, { userId: user.id, action: "request_delete", table, recordId: id, oldData: old, ip });
    return { applied: false, change: rows[0] };
  });
}

// ---------- Verify / reject (super admin) ----------
export async function verifyRecord(admin: AuthUser, table: string, id: string, ip?: string) {
  const conf = cfg(table);
  return tx(async (c) => {
    const old = await lockRecord(c, table, id);
    if (old.status !== "pending") throw new HttpError(409, `This record is already ${old.status}`);
    const { rows } = await c.query(
      `UPDATE ${table} SET status = 'verified', verified_by = $2, verified_at = now(), rejection_reason = NULL
       WHERE id = $1 RETURNING *`, [id, admin.id]);
    await conf.onVerify?.(c, rows[0]);
    await audit(c, { userId: admin.id, action: "verify", table, recordId: id, oldData: old, newData: rows[0], ip });
    return rows[0];
  });
}

export async function rejectRecord(admin: AuthUser, table: string, id: string, reason: string, ip?: string) {
  cfg(table);
  return tx(async (c) => {
    const old = await lockRecord(c, table, id);
    if (old.status !== "pending") throw new HttpError(409, `This record is already ${old.status}`);
    const { rows } = await c.query(
      `UPDATE ${table} SET status = 'rejected', rejection_reason = $2, verified_by = $3, verified_at = now()
       WHERE id = $1 RETURNING *`, [id, reason, admin.id]);
    await audit(c, { userId: admin.id, action: "reject", table, recordId: id, oldData: old, newData: rows[0], ip });
    return rows[0];
  });
}

// ---------- Approve / reject a staff change request (super admin) ----------
export async function approveChange(admin: AuthUser, changeId: string, ip?: string) {
  return tx(async (c) => {
    const ch = await c.query("SELECT * FROM record_changes WHERE id = $1 FOR UPDATE", [changeId]);
    const change = ch.rows[0];
    if (!change) throw new HttpError(404, "Change request not found");
    if (change.status !== "pending") throw new HttpError(409, `This request is already ${change.status}`);

    const table: string = change.table_name;
    const conf = cfg(table);
    const id = String(change.record_id);
    const old = await lockRecord(c, table, id);

    await allowVerifiedChange(c);
    if (change.kind === "edit") {
      const data = change.proposed as FieldData;
      checkFields(table, data); // check again, in case the rules changed
      const updatedDb = await updateFields(c, table, id, data);
      const updated = { ...updatedDb, ...data }; // Merge virtual fields for hooks
      if (old.status === "verified") await conf.afterEdit?.(c, old, updated);
      await audit(c, { userId: admin.id, action: "approve_edit", table, recordId: id, oldData: old, newData: updated, ip });
    } else {
      await conf.cleanupOnDelete?.(c, id);
      await c.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
      await audit(c, { userId: admin.id, action: "approve_delete", table, recordId: id, oldData: old, ip });
    }
    const done = await c.query(
      `UPDATE record_changes SET status = 'verified', reviewed_by = $2, reviewed_at = now()
       WHERE id = $1 RETURNING *`, [changeId, admin.id]);
    return done.rows[0];
  });
}

export async function rejectChange(admin: AuthUser, changeId: string, reason: string, ip?: string) {
  return tx(async (c) => {
    const ch = await c.query("SELECT * FROM record_changes WHERE id = $1 FOR UPDATE", [changeId]);
    const change = ch.rows[0];
    if (!change) throw new HttpError(404, "Change request not found");
    if (change.status !== "pending") throw new HttpError(409, `This request is already ${change.status}`);
    const { rows } = await c.query(
      `UPDATE record_changes SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), rejection_reason = $3
       WHERE id = $1 RETURNING *`, [changeId, admin.id, reason]);
    await audit(c, { userId: admin.id, action: "reject_change", table: change.table_name, recordId: change.record_id, newData: { reason }, ip });
    return rows[0];
  });
}

// ---------- Lists for the admin screen ----------
export async function pendingSummary() {
  const counts: Record<string, number> = {};
  for (const table of Object.keys(TABLES)) {
    const r = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE status = 'pending'`);
    counts[table] = r.rows[0].n;
  }
  const ch = await pool.query("SELECT count(*)::int AS n FROM record_changes WHERE status = 'pending'");
  const total = Object.values(counts).reduce((a, b) => a + b, 0) + ch.rows[0].n;
  return { total, records: counts, changeRequests: ch.rows[0].n };
}

export async function listPending(table: string, limit: number, offset: number) {
  cfg(table);
  const r = await pool.query(
    `SELECT * FROM ${table} WHERE status = 'pending' ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
  return r.rows;
}

export async function listChanges() {
  const r = await pool.query(
    `SELECT rc.*, u.full_name AS requested_by_name
     FROM record_changes rc JOIN users u ON u.id = rc.requested_by
     WHERE rc.status = 'pending' ORDER BY rc.requested_at`);
  return r.rows;
}
