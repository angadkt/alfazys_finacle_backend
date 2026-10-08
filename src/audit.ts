import type { Queryable } from "./db";

export interface AuditEntry {
  userId: string | null;
  action: string;          // login, create, update, verify, reject, request_edit, ...
  table?: string;
  recordId?: string | number;
  oldData?: unknown;
  newData?: unknown;
  ip?: string;
}

/** Pass a pool client inside a transaction, so the log is saved or rolled back with the change. */
export async function audit(db: Queryable, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (user_id, action, table_name, record_id, old_data, new_data, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      e.userId,
      e.action,
      e.table ?? null,
      e.recordId ?? null,
      e.oldData === undefined ? null : JSON.stringify(e.oldData),
      e.newData === undefined ? null : JSON.stringify(e.newData),
      e.ip ?? null,
    ],
  );
}
