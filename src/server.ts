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
