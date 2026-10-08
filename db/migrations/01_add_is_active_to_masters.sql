-- Add is_active to masters so super admin can deactivate them without deleting.
ALTER TABLE cif_types ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE branches ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE expense_categories ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE;
