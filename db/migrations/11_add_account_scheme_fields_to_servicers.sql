-- Migration 11: Add account scheme fields to servicers table
ALTER TABLE servicers ADD COLUMN IF NOT EXISTS account_type TEXT DEFAULT 'SERVICER';
ALTER TABLE servicers ADD COLUMN IF NOT EXISTS sanctioned_limit NUMERIC(15,2) DEFAULT 0;
ALTER TABLE servicers ADD COLUMN IF NOT EXISTS initial_deposit NUMERIC(15,2) DEFAULT 0;
ALTER TABLE servicers ADD COLUMN IF NOT EXISTS opening_date DATE;

