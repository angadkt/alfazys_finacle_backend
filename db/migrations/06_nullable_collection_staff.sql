-- collection_staff is no longer required (field removed from form)
ALTER TABLE received_aed
  ALTER COLUMN collection_staff DROP NOT NULL;
