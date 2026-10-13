-- Add entry_date to received_aed (defaults to the day the record was created)
ALTER TABLE received_aed
  ADD COLUMN IF NOT EXISTS entry_date DATE NOT NULL DEFAULT CURRENT_DATE;
