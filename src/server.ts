import fs from "fs";
import path from "path";
import { app } from "./app";
import { hashPassword } from "./auth/password";
import { MODULES } from "./auth/permissions";
import { config } from "./config";
import { pool, tx } from "./db";

/**
 * Execute each DDL statement independently so that any single statement failure
 * or duplicate condition does not abort subsequent migrations.
 */
async function executeIndividualDDLs(statements: string[], label: string) {
  for (const sql of statements) {
    const trimmed = sql.trim();
    if (!trimmed) continue;
    try {
      await pool.query(trimmed);
    } catch (err: any) {
      // Ignore 'already exists' or non-fatal notices, but log them
      if (
        err.message.includes("already exists") ||
        err.message.includes("duplicate key")
      ) {
        // expected idempotent behavior
      } else {
        console.warn(`[${label}] Notice executing SQL:`, err.message);
      }
    }
  }
}

/**
 * Automatically discovers, executes, and tracks pending migrations from db/migrations/
 */
async function runFileMigrations() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const migrationsDir = path.join(process.cwd(), "db", "migrations");
    if (fs.existsSync(migrationsDir)) {
      const files = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .sort();

      for (const file of files) {
        const check = await pool.query(
          "SELECT 1 FROM schema_migrations WHERE version = $1",
          [file]
        );
        if (check.rows.length === 0) {
          console.log(`Applying migration file: ${file}...`);
          const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
          try {
            await pool.query(sql);
            await pool.query(
              "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
              [file]
            );
            console.log(`✅ Successfully applied: ${file}`);
          } catch (migErr: any) {
            console.warn(`⚠️ Warning executing migration ${file}:`, migErr.message);
            // Record migration if error was an 'already exists' condition to prevent loops
            if (
              migErr.message.includes("already exists") ||
              migErr.message.includes("duplicate")
            ) {
              await pool.query(
                "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING",
                [file]
              );
            }
          }
        }
      }
    }
  } catch (err: any) {
    console.warn("Notice during file migrations:", err.message);
  }
}

async function initDatabase() {
  try {
    // 1. Check if database has baseline tables (e.g., users table)
    const exists = await pool.query("SELECT to_regclass('public.users') AS t");
    if (!exists.rows[0].t) {
      console.log("📦 Empty database detected. Running db/schema.sql...");
      const schemaPath = path.join(process.cwd(), "db", "schema.sql");
      if (fs.existsSync(schemaPath)) {
        const sql = fs.readFileSync(schemaPath, "utf8");
        await pool.query(sql);
        console.log("✅ Database tables created successfully from schema.sql");
      } else {
        console.warn(`⚠️ Schema file not found at ${schemaPath}`);
      }
    }

    // 2. Run file-based migrations (01 through 12)
    await runFileMigrations();

    // 3. Defense-in-depth: Ensure all sequences, tables, and columns exist regardless of migration order
    const CORE_DDL_UPDATES = [
      // Master list active columns
      "ALTER TABLE cif_types ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE",
      "ALTER TABLE branches ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE",
      "ALTER TABLE expense_categories ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE",

      // Sequences for servicers and payouts
      "CREATE SEQUENCE IF NOT EXISTS servicer_code_seq START 1001",
      "CREATE SEQUENCE IF NOT EXISTS servicer_acc_seq START 100100001001",
      "CREATE SEQUENCE IF NOT EXISTS servicer_acc_india_seq START 10",
      "CREATE SEQUENCE IF NOT EXISTS servicer_acc_uae_seq START 10",
      "CREATE SEQUENCE IF NOT EXISTS payout_txn_seq START 1",

      // Orders updates
      "ALTER TABLE orders ALTER COLUMN buyer_id DROP NOT NULL",
      "ALTER TABLE orders DROP CONSTRAINT IF EXISTS gateway_needs_rates",
      "ALTER TABLE orders DROP CONSTRAINT IF EXISTS usdt_needs_fields",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS party_id BIGINT REFERENCES parties(id)",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS receivers_data JSONB DEFAULT '[]'",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS receiver_name TEXT",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS receiver_account TEXT",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS receiver_ifsc TEXT",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS receiver_bank TEXT",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS receiver_branch TEXT",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS transaction_through TEXT",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(50) DEFAULT 'Pending'",

      // Credit entries updates
      "ALTER TABLE credit_entries ADD COLUMN IF NOT EXISTS beneficiary_name TEXT",
      "ALTER TABLE credit_entries ADD COLUMN IF NOT EXISTS account_number TEXT",
      "ALTER TABLE credit_entries ADD COLUMN IF NOT EXISTS ifsc_code TEXT",
      "ALTER TABLE credit_entries ADD COLUMN IF NOT EXISTS bank_name TEXT",
      "ALTER TABLE credit_entries ADD COLUMN IF NOT EXISTS branch_name TEXT",
      "ALTER TABLE credit_entries ADD COLUMN IF NOT EXISTS utrs_data JSONB DEFAULT '[]'",

      // Party documents updates
      "ALTER TABLE party_documents ADD COLUMN IF NOT EXISTS file_data BYTEA",
      "ALTER TABLE party_documents ADD COLUMN IF NOT EXISTS mime_type TEXT",
      "ALTER TABLE party_documents ADD COLUMN IF NOT EXISTS file_name TEXT",

      // Received AED table
      `CREATE TABLE IF NOT EXISTS received_aed (
        id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        aed_amount        NUMERIC(18,2) NOT NULL CHECK (aed_amount > 0),
        collection_staff  TEXT,
        mode_of_txn       TEXT NOT NULL,
        cash_staff        TEXT,
        remaining_amount  NUMERIC(18,2),
        entry_date        DATE NOT NULL DEFAULT CURRENT_DATE,
        created_by        BIGINT NOT NULL REFERENCES users(id),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      "ALTER TABLE received_aed ADD COLUMN IF NOT EXISTS entry_date DATE NOT NULL DEFAULT CURRENT_DATE",
      "ALTER TABLE received_aed ALTER COLUMN collection_staff DROP NOT NULL",
      "ALTER TABLE received_aed ADD COLUMN IF NOT EXISTS agent_customer TEXT",
      "ALTER TABLE received_aed ADD COLUMN IF NOT EXISTS utr_no TEXT",
      "ALTER TABLE received_aed ADD COLUMN IF NOT EXISTS description TEXT",

      // Daily rates constraint relax
      "ALTER TABLE daily_rates ALTER COLUMN sale_rate DROP NOT NULL",

      // Servicers table
      `CREATE TABLE IF NOT EXISTS servicers (
        id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        party_id        BIGINT REFERENCES parties(id),
        cif_no          TEXT,
        servicer_code   TEXT NOT NULL UNIQUE DEFAULT ('SER-' || nextval('servicer_code_seq')::text),
        name            TEXT NOT NULL,
        phone           TEXT,
        city            TEXT,
        branch          TEXT DEFAULT 'INDIA',
        bank_name       TEXT,
        account_no      TEXT,
        ifsc_code       TEXT,
        bank_accounts   JSONB DEFAULT '[]',
        commission_rate NUMERIC(8,4) NOT NULL DEFAULT 0.2500,
        status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
        account_type    TEXT DEFAULT 'SERVICER',
        sanctioned_limit NUMERIC(15,2) DEFAULT 0,
        initial_deposit NUMERIC(15,2) DEFAULT 0,
        opening_date    DATE,
        created_by      BIGINT REFERENCES users(id),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      "ALTER TABLE servicers ADD COLUMN IF NOT EXISTS party_id BIGINT REFERENCES parties(id)",
      "ALTER TABLE servicers ADD COLUMN IF NOT EXISTS cif_no TEXT",
      "ALTER TABLE servicers ADD COLUMN IF NOT EXISTS branch TEXT DEFAULT 'INDIA'",
      "ALTER TABLE servicers ADD COLUMN IF NOT EXISTS bank_accounts JSONB DEFAULT '[]'",
      "ALTER TABLE servicers ADD COLUMN IF NOT EXISTS account_type TEXT DEFAULT 'SERVICER'",
      "ALTER TABLE servicers ADD COLUMN IF NOT EXISTS sanctioned_limit NUMERIC(15,2) DEFAULT 0",
      "ALTER TABLE servicers ADD COLUMN IF NOT EXISTS initial_deposit NUMERIC(15,2) DEFAULT 0",
      "ALTER TABLE servicers ADD COLUMN IF NOT EXISTS opening_date DATE",

      // Servicer transactions table
      `CREATE TABLE IF NOT EXISTS servicer_transactions (
        id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        txn_no              TEXT NOT NULL UNIQUE DEFAULT ('TXN-' || lpad(nextval('payout_txn_seq')::text, 6, '0')),
        servicer_id         BIGINT REFERENCES servicers(id),
        channel             TEXT NOT NULL DEFAULT 'servicer' CHECK (channel IN ('servicer', 'direct')),
        txn_type            TEXT NOT NULL CHECK (txn_type IN ('float_credit', 'payout_debit', 'conversion', 'reimbursement', 'commission_settle')),
        direction           TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        wallet_type         TEXT NOT NULL CHECK (wallet_type IN ('bank', 'cash', 'direct')),
        amount              NUMERIC(18,2) NOT NULL CHECK (amount > 0),
        order_id            BIGINT REFERENCES orders(id),
        receiver_index      INT,
        beneficiary_name    TEXT,
        beneficiary_account TEXT,
        beneficiary_bank    TEXT,
        beneficiary_ifsc    TEXT,
        expected_amount     NUMERIC(18,2),
        variance_amount     NUMERIC(18,2) DEFAULT 0,
        variance_reason     TEXT,
        commission_rate     NUMERIC(8,4) DEFAULT 0,
        commission_amount   NUMERIC(18,2) DEFAULT 0,
        commission_settled  BOOLEAN NOT NULL DEFAULT false,
        payment_mode        TEXT NOT NULL DEFAULT 'bank_transfer',
        utr_number          TEXT,
        proof_file_key      TEXT,
        note                TEXT,
        status              record_status NOT NULL DEFAULT 'verified',
        entry_date          DATE NOT NULL DEFAULT CURRENT_DATE,
        bounced             BOOLEAN NOT NULL DEFAULT false,
        bounced_at          TIMESTAMPTZ,
        bounced_reason      TEXT,
        created_by          BIGINT REFERENCES users(id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      "ALTER TABLE servicer_transactions ADD COLUMN IF NOT EXISTS beneficiary_branch TEXT"
    ];

    await executeIndividualDDLs(CORE_DDL_UPDATES, "Core DDL Check");

    // 4. Safe master data seeding (by UNIQUE name, safe on conflict)
    const defaultCifs = ['AGENT', 'CUSTOMER', 'EMPLOYEE', 'OTHER', 'GENERAL', 'SERVICER', 'SUPPLIER'];
    for (const name of defaultCifs) {
      await pool.query(
        "INSERT INTO cif_types (name, is_active) VALUES ($1, true) ON CONFLICT (name) DO UPDATE SET is_active = true",
        [name]
      ).catch(() => {});
    }

    const defaultBranches = ['UAE', 'INDIA'];
    for (const name of defaultBranches) {
      await pool.query(
        "INSERT INTO branches (name, is_active) VALUES ($1, true) ON CONFLICT (name) DO UPDATE SET is_active = true",
        [name]
      ).catch(() => {});
    }

    console.log("✅ Database schema & migrations verified successfully");

    // 5. Ensure super admin account (infazyss@gmail.com / Infaz@1010) is active and up to date
    const usersTable = await pool.query("SELECT to_regclass('public.users') AS t");
    if (usersTable.rows[0].t) {
      const targetAdminEmail = (process.env.ADMIN_EMAIL || "infazyss@gmail.com").toLowerCase();
      const targetAdminPass = process.env.ADMIN_PASSWORD || "Infaz@1010";
      const targetAdminName = process.env.ADMIN_NAME || "Super Admin";

      await tx(async (c) => {
        const hashed = await hashPassword(targetAdminPass);

        // Check if new admin email already exists
        const existing = await c.query("SELECT id FROM users WHERE email = $1", [targetAdminEmail]);
        let adminId: string | number;

        if (existing.rows.length > 0) {
          adminId = existing.rows[0].id;
          await c.query(
            "UPDATE users SET password_hash = $1, role = 'admin', is_active = true WHERE id = $2",
            [hashed, adminId],
          );
        } else {
          // Check if legacy super admin email exists to rename it
          const legacy = await c.query(
            "SELECT id FROM users WHERE email = 'infazyssuperadmin@gmail.com' OR email = 'admin@admin.com' LIMIT 1",
          );
          if (legacy.rows.length > 0) {
            adminId = legacy.rows[0].id;
            await c.query(
              "UPDATE users SET email = $1, password_hash = $2, role = 'admin', is_active = true WHERE id = $3",
              [targetAdminEmail, hashed, adminId],
            );
          } else {
            // Check if any admin exists
            const anyAdmin = await c.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
            if (anyAdmin.rows.length > 0) {
              adminId = anyAdmin.rows[0].id;
              await c.query(
                "UPDATE users SET email = $1, password_hash = $2, is_active = true WHERE id = $3",
                [targetAdminEmail, hashed, adminId],
              );
            } else {
              // Create new admin
              const inserted = await c.query(
                "INSERT INTO users (full_name, email, password_hash, role, is_active) VALUES ($1, $2, $3, 'admin', true) RETURNING id",
                [targetAdminName, targetAdminEmail, hashed],
              );
              adminId = inserted.rows[0].id;
            }
          }
        }

        // Clean up legacy superadmin email if it still exists separately
        if (targetAdminEmail !== "infazyssuperadmin@gmail.com") {
          await c.query("DELETE FROM users WHERE email = 'infazyssuperadmin@gmail.com' AND id != $1", [adminId]);
        }

        // Ensure all module permissions
        for (const m of MODULES) {
          await c.query(
            "INSERT INTO user_permissions (user_id, module, level) VALUES ($1, $2, 'edit') ON CONFLICT (user_id, module) DO UPDATE SET level = 'edit'",
            [adminId, m],
          );
        }

        console.log(`✅ Super admin account ready: ${targetAdminEmail}`);
      });
    }
  } catch (err: any) {
    console.error("❌ Database initialization error:", err.message);
  }
}

async function start() {
  await initDatabase();

  const server = app.listen(config.PORT, () => {
    console.log(`API running on port ${config.PORT}`);
  });

  async function stop() {
    server.close();
    await pool.end();
    process.exit(0);
  }
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

start().catch((err) => {
  console.error("Server startup error:", err);
  process.exit(1);
});
