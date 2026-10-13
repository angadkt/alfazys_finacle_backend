-- Received AED entries — tracks AED collections
CREATE TABLE IF NOT EXISTS received_aed (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aed_amount        NUMERIC(18,2) NOT NULL CHECK (aed_amount > 0),
  collection_staff  TEXT NOT NULL,
  mode_of_txn       TEXT NOT NULL,
  cash_staff        TEXT,              -- only when mode_of_txn = 'BY CASH'
  remaining_amount  NUMERIC(18,2),
  created_by        BIGINT NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
