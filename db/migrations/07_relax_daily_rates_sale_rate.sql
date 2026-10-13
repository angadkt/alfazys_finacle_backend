ALTER TABLE daily_rates ALTER COLUMN sale_rate DROP NOT NULL;
ALTER TABLE daily_rates DROP CONSTRAINT IF EXISTS daily_rates_sale_rate_check;
ALTER TABLE daily_rates ADD CONSTRAINT daily_rates_sale_rate_check CHECK (sale_rate IS NULL OR sale_rate > 0);
