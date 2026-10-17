-- Add utr_no and description columns to received_aed table
ALTER TABLE received_aed
  ADD COLUMN IF NOT EXISTS utr_no TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT;
