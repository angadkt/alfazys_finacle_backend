import type { PoolClient } from "pg";
import type { Module } from "./auth/permissions";

/**
 * Tables that use the pending -> verified workflow.
 * Only names in this list can ever be used in SQL (see makerChecker.ts).
 *
 * editable : the only columns staff/admin may change through the generic edit route.
 * onVerify : (later steps) runs inside the same transaction when the admin verifies,
 *            for example: add cash book rows, create commissions.
 * afterEdit: (later steps) runs when a VERIFIED record is changed, to fix cash book rows.
 * cleanupOnDelete: runs before a record is deleted, to remove rows that depend on it.
 */
export interface TableConfig {
  module: Module;
  editable: string[];
  onVerify?: (c: PoolClient, row: any) => Promise<void>;
  afterEdit?: (c: PoolClient, oldRow: any, newRow: any) => Promise<void>;
  cleanupOnDelete?: (c: PoolClient, id: string) => Promise<void>;
}

const removeMovements = (table: string) => async (c: PoolClient, id: string) => {
  await c.query("DELETE FROM account_movements WHERE source_table = $1 AND source_id = $2", [table, id]);
};

export const TABLES: Record<string, TableConfig> = {
  parties: {
    module: "financial",
    editable: ["kind", "cif_type_id", "first_name", "last_name", "short_name", "gender", "nationality",
      "contact_number", "branch_id", "indian_number", "whatsapp_number", "email", "agent_id",
      "special_rate", "commission_type", "commission_value", "_profile"],
    afterEdit: async (c, oldRow, newRow) => {
      if (newRow._profile) {
        const { contacts, addresses, receivers } = newRow._profile;
        const partyId = newRow.id;
        
        if (contacts) {
          await c.query("DELETE FROM party_contacts WHERE party_id = $1", [partyId]);
          for (const con of contacts) {
            await c.query("INSERT INTO party_contacts (party_id, number, relation) VALUES ($1, $2, $3)", [partyId, con.number, con.relation]);
          }
        }
        
        if (addresses) {
          await c.query("DELETE FROM party_addresses WHERE party_id = $1", [partyId]);
          for (const addr of addresses) {
            await c.query(`INSERT INTO party_addresses 
              (party_id, address_format, address_type, house_no, premise_name, building_level, street_no, suburb, street_name, locality, town, city, state, country, postal_code, valid_from, valid_till, address_proof_received) 
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`, 
              [partyId, addr.address_format, addr.address_type, addr.house_no, addr.premise_name, addr.building_level, addr.street_no, addr.suburb, addr.street_name, addr.locality, addr.town, addr.city, addr.state, addr.country, addr.postal_code, addr.valid_from, addr.valid_till, addr.address_proof_received]);
          }
        }
        
        if (receivers) {
          await c.query("DELETE FROM receivers WHERE party_id = $1", [partyId]);
          for (const rec of receivers) {
            await c.query("INSERT INTO receivers (party_id, name, bank_name, account_no, ifsc, upi_id, phone) VALUES ($1, $2, $3, $4, $5, $6, $7)", [partyId, rec.name, rec.bank_name, rec.account_no, rec.ifsc, rec.upi_id, rec.phone]);
          }
        }
      }
    }
  },
  daily_rates: {
    module: "financial",
    editable: ["rate_date", "cost_rate", "sale_rate", "usdt_rate_aed"],
  },
  credit_entries: {
    module: "financial",
    editable: ["party_id", "entry_date", "aed_amount", "mode", "account_id", "utr_number", "customer_rate", "note",
      "beneficiary_name", "account_number", "ifsc_code", "bank_name", "branch_name", "utrs_data"],
    cleanupOnDelete: removeMovements("credit_entries"),
  },
  orders: {
    module: "financial",
    editable: ["buyer_id", "party_id", "txn", "order_date", "aed_amount", "account_id", "sale_rate", "cost_rate",
      "usdt_amount", "usdt_rate_aed", "inr_per_usdt", "inr_value", "expected_profit_inr", "note",
      "transaction_through", "payment_status", "receivers_data", "receiver_name", "receiver_account",
      "receiver_ifsc", "receiver_bank", "receiver_branch"],
    cleanupOnDelete: removeMovements("orders"),
  },
  debit_entries: {
    module: "financial",
    editable: ["buyer_id", "party_id", "receiver_id", "entry_date", "inr_amount", "mode", "reference_no",
      "proof_file_key", "note"],
    cleanupOnDelete: async (c, id) => {
      await c.query("DELETE FROM commissions WHERE debit_entry_id = $1", [id]);
    },
  },
  expenses: {
    module: "financial",
    editable: ["expense_date", "category_id", "amount", "currency", "amount_inr", "account_id", "receipt_file_key", "note"],
    cleanupOnDelete: removeMovements("expenses"),
  },
  settlements: {
    module: "financial",
    editable: ["settle_date", "buyer_id", "agent_id", "direction", "amount", "currency", "account_id", "proof_file_key", "note"],
    cleanupOnDelete: removeMovements("settlements"),
  },
};
