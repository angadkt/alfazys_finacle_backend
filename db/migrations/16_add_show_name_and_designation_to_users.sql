-- Add show_name, designation, and staff_code to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS show_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS designation TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_code TEXT;
