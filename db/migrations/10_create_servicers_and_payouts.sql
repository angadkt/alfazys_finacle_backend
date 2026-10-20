-- Migration 10: Create Servicers and Payout Transactions

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

CREATE INDEX IF NOT EXISTS idx_servicer_txns_servicer ON servicer_transactions(servicer_id);
CREATE INDEX IF NOT EXISTS idx_servicer_txns_order ON servicer_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_servicer_txns_date ON servicer_transactions(entry_date);
CREATE INDEX IF NOT EXISTS idx_servicer_txns_utr ON servicer_transactions(utr_number) WHERE utr_number IS NOT NULL;
