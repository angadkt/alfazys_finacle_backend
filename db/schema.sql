-- =====================================================================
-- Financial Management module - PostgreSQL schema (version 1)
-- Rules:
--  * Money uses NUMERIC only, never float.
--  * Rates are "INR per 1 AED" with 6 decimals.
--  * Only VERIFIED records count in balances and reports.
--  * Staff records start as 'pending'. Only super_admin can verify.
-- =====================================================================

-- ---------- Types ----------
CREATE TYPE user_role     AS ENUM ('admin', 'staff', 'agent');
CREATE TYPE record_status AS ENUM ('pending', 'verified', 'rejected');
CREATE TYPE module_name   AS ENUM ('financial', 'flat', 'investment');
CREATE TYPE access_level  AS ENUM ('none', 'view', 'edit');
CREATE TYPE party_kind    AS ENUM ('customer', 'agent');
CREATE TYPE txn_type      AS ENUM ('gateway', 'usdt', 'reverse');  -- 'reverse' is for later
CREATE TYPE credit_mode   AS ENUM ('cash', 'bank_transfer');
CREATE TYPE debit_mode    AS ENUM ('cdm', 'bank_slip', 'bank_transfer', 'cheque', 'upi', 'by_hand');
CREATE TYPE currency_code AS ENUM ('AED', 'INR', 'USDT');

-- ---------- Users and permissions ----------
CREATE TABLE users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  full_name     TEXT        NOT NULL,
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,              -- argon2 or bcrypt hash only
  role          user_role   NOT NULL DEFAULT 'staff',
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE user_permissions (
  user_id BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module  module_name  NOT NULL,
  level   access_level NOT NULL DEFAULT 'none',
  PRIMARY KEY (user_id, module)
);

-- ---------- Master lists (admin can edit) ----------
CREATE TABLE cif_types (
  id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE               -- example: Individual, Agent, Company
);

CREATE TABLE branches (
  id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE expense_categories (
  id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- Cash and bank accounts. Every money movement touches one of these.
CREATE TABLE accounts (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            TEXT          NOT NULL UNIQUE,   -- example: "Cash AED", "ENBD AED"
  kind            TEXT          NOT NULL CHECK (kind IN ('cash', 'bank')),
  currency        currency_code NOT NULL,
  opening_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE
);

-- ---------- Customers and agents (CIF) ----------
CREATE SEQUENCE cif_no_seq START 1000;

CREATE TABLE parties (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cif_no           TEXT NOT NULL UNIQUE DEFAULT ('CIF' || nextval('cif_no_seq')),
  kind             party_kind NOT NULL DEFAULT 'customer',
  cif_type_id      BIGINT REFERENCES cif_types(id),
  first_name       TEXT NOT NULL,
  last_name        TEXT,
  short_name       TEXT,
  gender           TEXT,
  nationality      TEXT,
  contact_number   TEXT NOT NULL,
  ccy              currency_code NOT NULL DEFAULT 'AED' CHECK (ccy = 'AED'),
  branch_id        BIGINT REFERENCES branches(id),
  indian_number    TEXT,
  whatsapp_number  TEXT,
  email            TEXT,
  agent_id         BIGINT REFERENCES parties(id),  -- the agent who brought this customer
  special_rate     NUMERIC(12,6),                  -- optional fixed rate for this party
  commission_type  TEXT CHECK (commission_type IN ('percent', 'fixed')),   -- agents only
  commission_value NUMERIC(12,4),
  status           record_status NOT NULL DEFAULT 'pending',
  created_by       BIGINT NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_by      BIGINT REFERENCES users(id),
  verified_at      TIMESTAMPTZ,
  rejection_reason TEXT,
  CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
);
-- Stop duplicate customers by phone number
CREATE UNIQUE INDEX uq_party_contact ON parties(contact_number) WHERE status <> 'rejected';

-- Two other numbers and their relations
CREATE TABLE party_contacts (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  party_id  BIGINT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  number    TEXT NOT NULL,
  relation  TEXT NOT NULL
);

-- Documents: files are in private storage, only the key is saved here
CREATE TABLE party_documents (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  party_id        BIGINT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  doc_type        TEXT NOT NULL CHECK (doc_type IN
                  ('photo','aadhaar_front','aadhaar_back','pan','uae_id',
                   'passport_front','passport_back','signature')),
  file_key        TEXT NOT NULL,
  doc_number_enc  TEXT,           -- encrypted by the app
  doc_number_last4 TEXT,          -- for masked display
  doc_number_hash TEXT,           -- for duplicate check
  expiry_date     DATE,
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_party_doc_number ON party_documents(doc_type, doc_number_hash)
  WHERE doc_number_hash IS NOT NULL;

CREATE TABLE party_addresses (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  party_id                BIGINT NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  address_format          TEXT    NOT NULL,
  address_type            TEXT    NOT NULL,
  house_no                TEXT    NOT NULL,
  premise_name            TEXT,
  building_level          TEXT,
  street_no               TEXT    NOT NULL,
  suburb                  TEXT,
  street_name             TEXT    NOT NULL,
  locality                TEXT,
  town                    TEXT,
  city                    TEXT    NOT NULL,
  state                   TEXT    NOT NULL,
  country                 TEXT    NOT NULL,
  postal_code             TEXT    NOT NULL,
  valid_from              DATE    NOT NULL,
  valid_till              DATE,
  address_proof_received  BOOLEAN NOT NULL DEFAULT FALSE,
  last_updated            TIMESTAMPTZ NOT NULL DEFAULT now(),
  hold_mail               BOOLEAN NOT NULL DEFAULT FALSE,
  hold_mail_initiated_by  TEXT,
  business_center_name    TEXT,
  reason                  TEXT
);

-- Receivers in India (given by the customer or agent)
CREATE TABLE receivers (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  party_id     BIGINT NOT NULL REFERENCES parties(id),
  name         TEXT NOT NULL,
  bank_name    TEXT,
  account_no   TEXT,
  ifsc         TEXT,
  upi_id       TEXT,
  phone        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Buyers (servicers) ----------
CREATE TABLE buyers (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name             TEXT NOT NULL,
  contact_number   TEXT,
  commission_type  TEXT CHECK (commission_type IN ('percent', 'fixed')),  -- not used for USDT
  commission_value NUMERIC(12,4),
  commission_basis TEXT CHECK (commission_basis IN ('aed', 'inr')),       -- to confirm with client
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Daily rates (entered by admin each day) ----------
CREATE TABLE daily_rates (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rate_date        DATE NOT NULL UNIQUE,
  cost_rate        NUMERIC(12,6) NOT NULL CHECK (cost_rate > 0),
  sale_rate        NUMERIC(12,6) NOT NULL CHECK (sale_rate > 0),
  usdt_rate_aed    NUMERIC(12,6),               -- AED paid for 1 USDT (USDT type)
  status           record_status NOT NULL DEFAULT 'pending',
  created_by       BIGINT NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_by      BIGINT REFERENCES users(id),
  verified_at      TIMESTAMPTZ,
  rejection_reason TEXT,
  CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
);

-- ---------- Core entries ----------
CREATE SEQUENCE receipt_no_seq START 1;
CREATE SEQUENCE order_no_seq   START 1;
CREATE SEQUENCE debit_no_seq   START 1;

-- 1) CREDIT ENTRY: AED comes in from a customer or agent
CREATE TABLE credit_entries (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_no       TEXT NOT NULL UNIQUE DEFAULT ('RC-' || lpad(nextval('receipt_no_seq')::text, 6, '0')),
  party_id         BIGINT NOT NULL REFERENCES parties(id),
  entry_date       DATE NOT NULL,
  aed_amount       NUMERIC(18,2) NOT NULL CHECK (aed_amount > 0),
  mode             credit_mode NOT NULL,
  account_id       BIGINT NOT NULL REFERENCES accounts(id),   -- where the AED was received
  utr_number       TEXT,
  customer_rate    NUMERIC(12,6) NOT NULL CHECK (customer_rate > 0),  -- saved on the entry
  inr_due          NUMERIC(18,2) GENERATED ALWAYS AS (round(aed_amount * customer_rate, 2)) STORED,
  note             TEXT,
  status           record_status NOT NULL DEFAULT 'pending',
  created_by       BIGINT NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_by      BIGINT REFERENCES users(id),
  verified_at      TIMESTAMPTZ,
  rejection_reason TEXT,
  CONSTRAINT utr_needed_for_bank CHECK (mode <> 'bank_transfer' OR utr_number IS NOT NULL),
  CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
);
CREATE UNIQUE INDEX uq_credit_utr ON credit_entries(utr_number)
  WHERE utr_number IS NOT NULL AND status <> 'rejected';

-- 2) ORDER: admin pays a buyer (about the buyer, not the customer)
--   gateway: inr_value = aed_amount * cost_rate
--            expected_profit_inr = (cost_rate - sale_rate) * aed_amount
--   usdt:    inr_value = usdt_amount * inr_per_usdt (rate decided by buyer)
--            profit = what is left in the buyer wallet
-- The backend calculates inr_value and expected_profit_inr when saving.
CREATE TABLE orders (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_no            TEXT NOT NULL UNIQUE DEFAULT ('OR-' || lpad(nextval('order_no_seq')::text, 6, '0')),
  buyer_id            BIGINT REFERENCES buyers(id),
  party_id            BIGINT REFERENCES parties(id),
  receivers_data      JSONB DEFAULT '[]',
  receiver_name       TEXT,
  receiver_account    TEXT,
  receiver_ifsc       TEXT,
  receiver_bank       TEXT,
  receiver_branch     TEXT,
  txn                 txn_type NOT NULL DEFAULT 'gateway',
  order_date          DATE NOT NULL,
  aed_amount          NUMERIC(18,2) NOT NULL CHECK (aed_amount > 0),
  account_id          BIGINT REFERENCES accounts(id),         -- AED account the payment came from
  sale_rate           NUMERIC(12,6),
  cost_rate           NUMERIC(12,6),
  usdt_amount         NUMERIC(18,2),
  usdt_rate_aed       NUMERIC(12,6),
  inr_per_usdt        NUMERIC(12,6),
  inr_value           NUMERIC(18,2) NOT NULL,                 -- INR amount requested/delivered
  expected_profit_inr NUMERIC(18,2),
  note                TEXT,
  status              record_status NOT NULL DEFAULT 'pending',
  created_by          BIGINT NOT NULL REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_by         BIGINT REFERENCES users(id),
  verified_at         TIMESTAMPTZ,
  rejection_reason    TEXT,
  CONSTRAINT gateway_needs_rates CHECK (txn <> 'gateway' OR sale_rate IS NOT NULL),
  CONSTRAINT usdt_needs_fields   CHECK (txn <> 'usdt' OR (usdt_amount IS NOT NULL AND inr_per_usdt IS NOT NULL)),
  CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
);

-- 3) DEBIT ENTRY: buyer pays INR to the receiver in India
CREATE TABLE debit_entries (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  debit_no         TEXT NOT NULL UNIQUE DEFAULT ('DB-' || lpad(nextval('debit_no_seq')::text, 6, '0')),
  buyer_id         BIGINT NOT NULL REFERENCES buyers(id),
  party_id         BIGINT NOT NULL REFERENCES parties(id),    -- customer or agent
  receiver_id      BIGINT REFERENCES receivers(id),
  entry_date       DATE NOT NULL,
  inr_amount       NUMERIC(18,2) NOT NULL CHECK (inr_amount > 0),
  mode             debit_mode NOT NULL,
  reference_no     TEXT,
  proof_file_key   TEXT NOT NULL,                             -- image of the payment (required)
  note             TEXT,
  status           record_status NOT NULL DEFAULT 'pending',
  created_by       BIGINT NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_by      BIGINT REFERENCES users(id),
  verified_at      TIMESTAMPTZ,
  rejection_reason TEXT,
  CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
);

-- ---------- Commission, settlements, expenses ----------
-- Created by the backend when a debit entry is verified.
-- Buyer commission reduces net profit. Agent commission does NOT (agent ledger only).
CREATE TABLE commissions (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  beneficiary    TEXT NOT NULL CHECK (beneficiary IN ('buyer', 'agent')),
  buyer_id       BIGINT REFERENCES buyers(id),
  agent_id       BIGINT REFERENCES parties(id),
  debit_entry_id BIGINT REFERENCES debit_entries(id),
  amount         NUMERIC(18,2) NOT NULL,
  currency       currency_code NOT NULL DEFAULT 'INR',
  settled        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((beneficiary = 'buyer' AND buyer_id IS NOT NULL AND agent_id IS NULL)
      OR (beneficiary = 'agent' AND agent_id IS NOT NULL AND buyer_id IS NULL))
);

-- Payments to or from agents and buyers (no fixed date)
CREATE TABLE settlements (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settle_date      DATE NOT NULL,
  buyer_id         BIGINT REFERENCES buyers(id),
  agent_id         BIGINT REFERENCES parties(id),
  direction        TEXT NOT NULL CHECK (direction IN ('admin_pays', 'admin_receives')),
  amount           NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency         currency_code NOT NULL,
  account_id       BIGINT NOT NULL REFERENCES accounts(id),
  proof_file_key   TEXT,
  note             TEXT,
  status           record_status NOT NULL DEFAULT 'pending',
  created_by       BIGINT NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_by      BIGINT REFERENCES users(id),
  verified_at      TIMESTAMPTZ,
  rejection_reason TEXT,
  CHECK ((buyer_id IS NOT NULL AND agent_id IS NULL) OR (buyer_id IS NULL AND agent_id IS NOT NULL)),
  CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
);

CREATE TABLE expenses (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  expense_date     DATE NOT NULL,
  category_id      BIGINT NOT NULL REFERENCES expense_categories(id),
  amount           NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  currency         currency_code NOT NULL,
  amount_inr       NUMERIC(18,2) NOT NULL,    -- converted amount used in net profit
  account_id       BIGINT NOT NULL REFERENCES accounts(id),
  receipt_file_key TEXT,
  note             TEXT,
  status           record_status NOT NULL DEFAULT 'pending',
  created_by       BIGINT NOT NULL REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_by      BIGINT REFERENCES users(id),
  verified_at      TIMESTAMPTZ,
  rejection_reason TEXT,
  CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
);

-- ---------- Cash book ----------
-- The backend adds a row here when an entry is verified.
CREATE TABLE account_movements (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES accounts(id),
  moved_on     DATE NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  amount       NUMERIC(18,2) NOT NULL CHECK (amount > 0),
  source_table TEXT NOT NULL,
  source_id    BIGINT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE day_closes (
  close_date DATE PRIMARY KEY,
  closed_by  BIGINT NOT NULL REFERENCES users(id),
  closed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_locked  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE cash_counts (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  close_date       DATE NOT NULL REFERENCES day_closes(close_date),
  account_id       BIGINT NOT NULL REFERENCES accounts(id),
  system_balance   NUMERIC(18,2) NOT NULL,
  counted_balance  NUMERIC(18,2) NOT NULL,
  difference       NUMERIC(18,2) GENERATED ALWAYS AS (counted_balance - system_balance) STORED
);

-- ---------- Maker-checker for edits and delete requests ----------
-- A staff edit on a verified record is saved here. The old values stay active
-- until the admin verifies this change.
CREATE TABLE record_changes (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name       TEXT NOT NULL,
  record_id        BIGINT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('edit', 'delete')),
  proposed         JSONB,
  status           record_status NOT NULL DEFAULT 'pending',
  requested_by     BIGINT NOT NULL REFERENCES users(id),
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by      BIGINT REFERENCES users(id),
  reviewed_at      TIMESTAMPTZ,
  rejection_reason TEXT
);

-- ---------- Audit log ----------
CREATE TABLE audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT REFERENCES users(id),
  action      TEXT NOT NULL,              -- create, update, verify, reject, view_document ...
  table_name  TEXT,
  record_id   BIGINT,
  old_data    JSONB,
  new_data    JSONB,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Protect verified records ----------
-- A verified row cannot be changed or deleted unless the backend, inside an
-- approved change, runs:  SET LOCAL app.allow_verified_change = 'on';
CREATE FUNCTION block_verified_change() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'verified'
     AND current_setting('app.allow_verified_change', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Verified record % in % cannot be changed directly', OLD.id, TG_TABLE_NAME;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_credit  BEFORE UPDATE OR DELETE ON credit_entries
  FOR EACH ROW EXECUTE FUNCTION block_verified_change();
CREATE TRIGGER trg_protect_orders  BEFORE UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION block_verified_change();
CREATE TRIGGER trg_protect_debit   BEFORE UPDATE OR DELETE ON debit_entries
  FOR EACH ROW EXECUTE FUNCTION block_verified_change();
CREATE TRIGGER trg_protect_expense BEFORE UPDATE OR DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION block_verified_change();
CREATE TRIGGER trg_protect_settle  BEFORE UPDATE OR DELETE ON settlements
  FOR EACH ROW EXECUTE FUNCTION block_verified_change();
CREATE TRIGGER trg_protect_rates   BEFORE UPDATE OR DELETE ON daily_rates
  FOR EACH ROW EXECUTE FUNCTION block_verified_change();

-- ---------- Indexes ----------
CREATE INDEX ix_credit_party   ON credit_entries(party_id, entry_date);
CREATE INDEX ix_orders_buyer   ON orders(buyer_id, order_date);
CREATE INDEX ix_debit_buyer    ON debit_entries(buyer_id, entry_date);
CREATE INDEX ix_debit_party    ON debit_entries(party_id, entry_date);
CREATE INDEX ix_moves_account  ON account_movements(account_id, moved_on);
CREATE INDEX ix_audit_record   ON audit_log(table_name, record_id);

-- ---------- Reports (VERIFIED records only) ----------

-- Balance of every cash and bank account
CREATE VIEW v_account_balance AS
SELECT a.id, a.name, a.currency,
       a.opening_balance
       + COALESCE(SUM(CASE WHEN m.direction = 'in' THEN m.amount ELSE -m.amount END), 0) AS balance
FROM accounts a
LEFT JOIN account_movements m ON m.account_id = a.id
GROUP BY a.id;

-- Buyer wallet and tally check.
-- tally_difference_inr should be 0. If not, show the difference to the admin.
CREATE VIEW v_buyer_wallet AS
SELECT b.id AS buyer_id,
       b.name,
       COALESCE(o.inr_in, 0)                          AS inr_in,
       COALESCE(d.inr_out, 0)                         AS inr_out,
       COALESCE(o.inr_in, 0) - COALESCE(d.inr_out, 0) AS balance_inr,
       COALESCE(o.exp_profit, 0)                      AS expected_profit_inr,
       COALESCE(o.inr_in, 0) - COALESCE(d.inr_out, 0) - COALESCE(o.exp_profit, 0) AS tally_difference_inr
FROM buyers b
LEFT JOIN (SELECT buyer_id, SUM(inr_value) AS inr_in, SUM(expected_profit_inr) AS exp_profit
           FROM orders WHERE status = 'verified' GROUP BY buyer_id) o ON o.buyer_id = b.id
LEFT JOIN (SELECT buyer_id, SUM(inr_amount) AS inr_out
           FROM debit_entries WHERE status = 'verified' GROUP BY buyer_id) d ON d.buyer_id = b.id;

-- For each customer or agent: AED received, INR that should be delivered, INR delivered
CREATE VIEW v_party_position AS
SELECT p.id AS party_id, p.cif_no, p.first_name, p.kind,
       COALESCE(c.aed_in, 0)   AS aed_received,
       COALESCE(c.inr_due, 0)  AS inr_due,
       COALESCE(d.inr_paid, 0) AS inr_delivered,
       COALESCE(c.inr_due, 0) - COALESCE(d.inr_paid, 0) AS inr_pending
FROM parties p
LEFT JOIN (SELECT party_id, SUM(aed_amount) AS aed_in, SUM(inr_due) AS inr_due
           FROM credit_entries WHERE status = 'verified' GROUP BY party_id) c ON c.party_id = p.id
LEFT JOIN (SELECT party_id, SUM(inr_amount) AS inr_paid
           FROM debit_entries WHERE status = 'verified' GROUP BY party_id) d ON d.party_id = p.id;

-- Daily profit and net profit in INR
-- net profit = profit - other expenses - buyer commission
-- (agent commission is not included). Buyer commission is counted in INR only for now.
CREATE VIEW v_daily_net_profit AS
WITH p AS (
  SELECT order_date AS d, SUM(expected_profit_inr) AS profit
  FROM orders WHERE status = 'verified' GROUP BY order_date
), e AS (
  SELECT expense_date AS d, SUM(amount_inr) AS expenses
  FROM expenses WHERE status = 'verified' GROUP BY expense_date
), c AS (
  SELECT de.entry_date AS d, SUM(cm.amount) AS buyer_commission
  FROM commissions cm
  JOIN debit_entries de ON de.id = cm.debit_entry_id
  WHERE cm.beneficiary = 'buyer' AND cm.currency = 'INR' AND de.status = 'verified'
  GROUP BY de.entry_date
), days AS (
  SELECT d FROM p UNION SELECT d FROM e UNION SELECT d FROM c
)
SELECT d AS day,
       COALESCE(p.profit, 0)               AS profit_inr,
       COALESCE(e.expenses, 0)             AS expenses_inr,
       COALESCE(c.buyer_commission, 0)     AS buyer_commission_inr,
       COALESCE(p.profit, 0) - COALESCE(e.expenses, 0) - COALESCE(c.buyer_commission, 0) AS net_profit_inr
FROM days
LEFT JOIN p USING (d)
LEFT JOIN e USING (d)
LEFT JOIN c USING (d);
