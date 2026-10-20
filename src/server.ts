import fs from "fs";
import path from "path";
import { app } from "./app";
import { hashPassword } from "./auth/password";
import { MODULES } from "./auth/permissions";
import { config } from "./config";
import { pool, tx } from "./db";

async function initDatabase() {
  try {
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

        ALTER TABLE credit_entries ADD COLUMN IF NOT EXISTS beneficiary_name TEXT;
        ALTER TABLE credit_entries ADD COLUMN IF NOT EXISTS account_number TEXT;
        ALTER TABLE credit_entries ADD COLUMN IF NOT EXISTS ifsc_code TEXT;
        ALTER TABLE credit_entries ADD COLUMN IF NOT EXISTS bank_name TEXT;
        ALTER TABLE credit_entries ADD COLUMN IF NOT EXISTS branch_name TEXT;
        ALTER TABLE credit_entries ADD COLUMN IF NOT EXISTS utrs_data JSONB DEFAULT '[]';

        ALTER TABLE party_documents ADD COLUMN IF NOT EXISTS file_data BYTEA;
        ALTER TABLE party_documents ADD COLUMN IF NOT EXISTS mime_type TEXT;
        ALTER TABLE party_documents ADD COLUMN IF NOT EXISTS file_name TEXT;

        -- Received AED tracking table
        CREATE TABLE IF NOT EXISTS received_aed (
          id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          aed_amount        NUMERIC(18,2) NOT NULL CHECK (aed_amount > 0),
          collection_staff  TEXT,
          mode_of_txn       TEXT NOT NULL,
          cash_staff        TEXT,
          remaining_amount  NUMERIC(18,2),
          entry_date        DATE NOT NULL DEFAULT CURRENT_DATE,
          created_by        BIGINT NOT NULL REFERENCES users(id),
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE received_aed ADD COLUMN IF NOT EXISTS entry_date DATE NOT NULL DEFAULT CURRENT_DATE;
        ALTER TABLE received_aed ALTER COLUMN collection_staff DROP NOT NULL;
        ALTER TABLE received_aed ADD COLUMN IF NOT EXISTS agent_customer TEXT;
        ALTER TABLE received_aed ADD COLUMN IF NOT EXISTS utr_no TEXT;
        ALTER TABLE received_aed ADD COLUMN IF NOT EXISTS description TEXT;

        -- Relax daily rates sale_rate constraint
        ALTER TABLE daily_rates ALTER COLUMN sale_rate DROP NOT NULL;
        ALTER TABLE daily_rates DROP CONSTRAINT IF EXISTS daily_rates_sale_rate_check;
        ALTER TABLE daily_rates ADD CONSTRAINT daily_rates_sale_rate_check CHECK (sale_rate IS NULL OR sale_rate > 0);

        -- Servicers and Payouts
        CREATE SEQUENCE IF NOT EXISTS servicer_code_seq START 1001;
        CREATE TABLE IF NOT EXISTS servicers (
          id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          servicer_code   TEXT NOT NULL UNIQUE DEFAULT ('SER-' || nextval('servicer_code_seq')::text),
          name            TEXT NOT NULL,
          phone           TEXT,
          city            TEXT,
          bank_name       TEXT,
          account_no      TEXT,
          ifsc_code       TEXT,
          commission_rate NUMERIC(8,4) NOT NULL DEFAULT 0.2500,
          status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
          created_by      BIGINT REFERENCES users(id),
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        );

        CREATE SEQUENCE IF NOT EXISTS payout_txn_seq START 1;
        CREATE TABLE IF NOT EXISTS servicer_transactions (
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
        );
      `);
      console.log('✅ Migrations checked and executed');
    } catch (migErr: any) {
      console.warn('Migration check notice:', migErr.message);
    }

    const exists = await pool.query("SELECT to_regclass('public.users') AS t");
    if (!exists.rows[0].t) {
      console.log("📦 Empty database detected. Running db/schema.sql...");
      const schemaPath = path.join(process.cwd(), "db", "schema.sql");
      if (fs.existsSync(schemaPath)) {
        const sql = fs.readFileSync(schemaPath, "utf8");
        await pool.query(sql);
        console.log("✅ Database tables created successfully.");
      } else {
        console.warn(`⚠️ Schema file not found at ${schemaPath}`);
      }
    }

    // Auto-seed default admin if no admin account exists yet
    const usersTable = await pool.query("SELECT to_regclass('public.users') AS t");
    if (usersTable.rows[0].t) {
      const adminCheck = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
      if (adminCheck.rows.length === 0) {
        console.log("👤 Creating initial admin account...");
        const adminEmail = (process.env.ADMIN_EMAIL || "admin@admin.com").toLowerCase();
        const adminPass = process.env.ADMIN_PASSWORD || "adminPassword123!";
        const adminName = process.env.ADMIN_NAME || "Super Admin";

        await tx(async (c) => {
          const { rows } = await c.query(
            "INSERT INTO users (full_name, email, password_hash, role) VALUES ($1, $2, $3, 'admin') RETURNING id",
            [adminName, adminEmail, await hashPassword(adminPass)],
          );
          for (const m of MODULES) {
            await c.query(
              "INSERT INTO user_permissions (user_id, module, level) VALUES ($1, $2, 'edit') ON CONFLICT DO NOTHING",
              [rows[0].id, m],
            );
          }
        });
        console.log(`✅ Default admin account ready: ${adminEmail}`);
      }
    }
  } catch (err: any) {
    console.error("❌ Database initialization notice:", err.message);
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
