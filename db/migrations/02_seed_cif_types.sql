-- Seed initial CIF Types
INSERT INTO cif_types (name, is_active) VALUES 
  ('AGENT', true),
  ('CUSTOMER', true),
  ('EMPLOYEE', true),
  ('OTHER', true),
  ('SERVICER', true),
  ('PAYMENT DISTRIBUTER', true),
  ('SUPPLIER', true)
ON CONFLICT (name) DO NOTHING;
