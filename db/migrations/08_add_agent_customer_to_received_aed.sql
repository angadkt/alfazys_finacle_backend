-- Add agent_customer column to received_aed to track which agent/customer the AED is from
ALTER TABLE received_aed
  ADD COLUMN IF NOT EXISTS agent_customer TEXT;
