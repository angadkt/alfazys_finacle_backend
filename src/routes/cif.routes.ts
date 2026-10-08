import { Router } from "express";
import { z } from "zod";
import multer from "multer";
import { requireAuth, requireModule } from "../auth/middleware";
import { pool, tx } from "../db";
import { HttpError } from "../errors";
import { makerFields, editRecord } from "../makerChecker";
import { audit } from "../audit";
import { localDiskStorage } from "../services/storage";
import { encryptDocNumber, decryptDocNumber } from "../services/crypto";
import { readFileSync } from "fs";

const router = Router();
router.use(requireAuth);
router.use(requireModule("financial", "view"));

const upload = multer({ 
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB
});

// Zod schemas for CIF creation
const contactSchema = z.object({
  number: z.string().min(1),
  relation: z.string().min(1),
});

const addressSchema = z.object({
  address_format: z.string().min(1),
  address_type: z.string().min(1),
  house_no: z.string().min(1),
  premise_name: z.string().optional().nullable(),
  building_level: z.string().optional().nullable(),
  street_no: z.string().min(1),
  suburb: z.string().optional().nullable(),
  street_name: z.string().min(1),
  locality: z.string().optional().nullable(),
  town: z.string().optional().nullable(),
  city: z.string().min(1),
  state: z.string().min(1),
  country: z.string().min(1),
  postal_code: z.string().min(1),
  valid_from: z.string().min(10),
  valid_till: z.string().optional().nullable(),
  address_proof_received: z.boolean().default(false)
});

const receiverSchema = z.object({
  name: z.string().min(1),
  bank_name: z.string().optional().nullable(),
  account_no: z.string().optional().nullable(),
  ifsc: z.string().optional().nullable(),
  upi_id: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
});

const createPartySchema = z.object({
  kind: z.enum(["customer", "agent"]),
  cif_type_id: z.number().int().optional().nullable(),
  first_name: z.string().min(1),
  last_name: z.string().optional().nullable(),
  short_name: z.string().optional().nullable(),
  gender: z.string().optional().nullable(),
  nationality: z.string().optional().nullable(),
  contact_number: z.string().min(1),
  branch_id: z.number().int().optional().nullable(),
  indian_number: z.string().optional().nullable(),
  whatsapp_number: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  agent_id: z.number().int().optional().nullable(),
  special_rate: z.string().optional().nullable(),
  commission_type: z.enum(["percent", "fixed"]).optional().nullable(),
  commission_value: z.string().optional().nullable(),
  
  contacts: z.array(contactSchema).max(2).optional().default([]),
  addresses: z.array(addressSchema).min(1),
  receivers: z.array(receiverSchema).optional().default([]),
});

// POST /cif: Create new party
router.post("/", requireModule("financial", "edit"), async (req, res) => {
  const data = createPartySchema.parse(req.body);
  
  // Commission fields are only for agent
  if (data.kind === "customer") {
    data.commission_type = null;
    data.commission_value = null;
  }
  
  try {
    const result = await tx(async (c) => {
      if (data.agent_id) {
        const ag = await c.query("SELECT kind FROM parties WHERE id = $1", [data.agent_id]);
        if (!ag.rows[0] || ag.rows[0].kind !== "agent") throw new HttpError(400, "agent_id must point to a valid agent");
      }

      const makerInfo = makerFields(req.user!);
      
      const { rows } = await c.query(
        `INSERT INTO parties (
          kind, cif_type_id, first_name, last_name, short_name, gender, nationality, contact_number,
          branch_id, indian_number, whatsapp_number, email, agent_id, special_rate, commission_type, commission_value,
          status, created_by, verified_by, verified_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
        ) RETURNING *`,
        [
          data.kind, data.cif_type_id, data.first_name, data.last_name, data.short_name, data.gender, data.nationality,
          data.contact_number, data.branch_id, data.indian_number, data.whatsapp_number, data.email, data.agent_id,
          data.special_rate, data.commission_type, data.commission_value, makerInfo.status, makerInfo.created_by,
          makerInfo.verified_by, makerInfo.verified_at
        ]
      );
      
      const party = rows[0];
      const partyId = party.id;

      for (const con of data.contacts) {
        await c.query("INSERT INTO party_contacts (party_id, number, relation) VALUES ($1, $2, $3)", [partyId, con.number, con.relation]);
      }
      for (const addr of data.addresses) {
        await c.query(`INSERT INTO party_addresses 
          (party_id, address_format, address_type, house_no, premise_name, building_level, street_no, suburb, street_name, locality, town, city, state, country, postal_code, valid_from, valid_till, address_proof_received) 
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`, 
          [partyId, addr.address_format, addr.address_type, addr.house_no, addr.premise_name, addr.building_level, addr.street_no, addr.suburb, addr.street_name, addr.locality, addr.town, addr.city, addr.state, addr.country, addr.postal_code, addr.valid_from, addr.valid_till, addr.address_proof_received]);
      }
      for (const rec of data.receivers) {
        await c.query("INSERT INTO receivers (party_id, name, bank_name, account_no, ifsc, upi_id, phone) VALUES ($1, $2, $3, $4, $5, $6, $7)", [partyId, rec.name, rec.bank_name, rec.account_no, rec.ifsc, rec.upi_id, rec.phone]);
      }
      
      await audit(c, { userId: req.user!.id, action: "create", table: "parties", recordId: partyId, newData: { ...party, contacts: data.contacts, addresses: data.addresses, receivers: data.receivers }, ip: req.ip });
      return party;
    });
    res.json(result);
  } catch (err: any) {
    if (err.code === "23505") throw new HttpError(409, "A party with this contact number already exists");
    throw err;
  }
});

// GET /cif: List with filters and pagination
router.get("/", async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string) || 20));
  const offset = (page - 1) * limit;

  let q = "SELECT * FROM parties WHERE 1=1";
  const params: any[] = [];

  if (req.query.kind) { params.push(req.query.kind); q += ` AND kind = $${params.length}`; }
  if (req.query.status) { params.push(req.query.status); q += ` AND status = $${params.length}`; }
  if (req.query.cif_no) { params.push(`%${req.query.cif_no}%`); q += ` AND cif_no ILIKE $${params.length}`; }
  if (req.query.name) { params.push(`%${req.query.name}%`); q += ` AND (first_name ILIKE $${params.length} OR last_name ILIKE $${params.length})`; }
  if (req.query.phone) { params.push(`%${req.query.phone}%`); q += ` AND contact_number ILIKE $${params.length}`; }

  const countQuery = `SELECT COUNT(*) FROM (${q}) t`;
  q += ` ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  
  const totalRes = await pool.query(countQuery, params);
  const { rows } = await pool.query(q, [...params, limit, offset]);
  
  res.json({ total: parseInt(totalRes.rows[0].count), page, limit, records: rows });
});

// GET /cif/missing-documents
router.get("/missing-documents", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.id, p.cif_no, p.first_name, p.last_name, p.contact_number, d.doc_type, d.expiry_date
    FROM parties p
    LEFT JOIN party_documents d ON d.party_id = p.id
    WHERE p.status = 'verified'
      AND (d.id IS NULL OR d.expiry_date <= CURRENT_DATE + INTERVAL '60 days')
    ORDER BY p.id DESC
  `);
  res.json(rows);
});

// GET /cif/:id
router.get("/:id", async (req, res) => {
  const id = z.string().regex(/^\d+$/).parse(req.params.id);
  const partyRes = await pool.query("SELECT * FROM parties WHERE id = $1", [id]);
  if (!partyRes.rows[0]) throw new HttpError(404, "Party not found");
  
  const party = partyRes.rows[0];
  party.contacts = (await pool.query("SELECT * FROM party_contacts WHERE party_id = $1", [id])).rows;
  party.addresses = (await pool.query("SELECT * FROM party_addresses WHERE party_id = $1", [id])).rows;
  party.receivers = (await pool.query("SELECT * FROM receivers WHERE party_id = $1", [id])).rows;
  
  // Omit the encrypted field and hash when sending to frontend
  const docs = await pool.query("SELECT id, doc_type, doc_number_last4, expiry_date, uploaded_at FROM party_documents WHERE party_id = $1", [id]);
  party.documents = docs.rows;
  
  res.json(party);
});

// PATCH /cif/:id/profile: Unified child record update via maker-checker
router.patch("/:id/profile", requireModule("financial", "edit"), async (req, res) => {
  const id = z.string().regex(/^\d+$/).parse(req.params.id);
  const data = z.object({
    contacts: z.array(contactSchema).max(2).optional(),
    addresses: z.array(addressSchema).min(1).optional(),
    receivers: z.array(receiverSchema).optional(),
  }).parse(req.body);

  const result = await editRecord(req.user!, "parties", id, { _profile: data }, req.ip);
  res.json(result);
});

function getMagicType(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;
  const hex = buffer.toString('hex', 0, 4).toUpperCase();
  if (hex.startsWith('FFD8FF')) return 'image/jpeg';
  if (hex === '89504E47') return 'image/png';
  if (hex === '25504446') return 'application/pdf';
  if (buffer.length >= 12) {
    const riff = buffer.toString('ascii', 0, 4);
    const webp = buffer.toString('ascii', 8, 12);
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  }
  return null;
}

const docSchema = z.object({
  doc_type: z.enum(['photo','aadhaar_front','aadhaar_back','pan','uae_id','passport_front','passport_back','signature']),
  doc_number: z.string().optional(), // We encrypt this
  expiry_date: z.string().optional().nullable(),
});

// POST /cif/:id/documents: Upload document
router.post("/:id/documents", requireModule("financial", "edit"), upload.single('file'), async (req, res) => {
  const id = z.string().regex(/^\d+$/).parse(req.params.id);
  const data = docSchema.parse(req.body);
  
  if (!req.file) throw new HttpError(400, "No file uploaded");
  const mime = getMagicType(req.file.buffer);
  if (!mime) throw new HttpError(400, "Invalid file type. Only JPEG, PNG, WebP, and PDF are allowed.");

  const ext = mime.split('/')[1];
  const fileKey = await localDiskStorage.saveFile(req.file.buffer, ext);

  let docEnc = null, docLast4 = null, docHash = null;
  if (data.doc_number) {
    const enc = encryptDocNumber(data.doc_number);
    docEnc = enc.doc_number_enc;
    docLast4 = enc.doc_number_last4;
    docHash = enc.doc_number_hash;
  }

  try {
    const result = await tx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO party_documents 
         (party_id, doc_type, file_key, doc_number_enc, doc_number_last4, doc_number_hash, expiry_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, data.doc_type, fileKey, docEnc, docLast4, docHash, data.expiry_date || null]
      );
      await audit(c, { userId: req.user!.id, action: "upload_document", table: "party_documents", recordId: rows[0].id, newData: { party_id: id, doc_type: data.doc_type }, ip: req.ip });
      return rows[0];
    });
    // Omit the exact encrypted string from response for security best practices
    res.json({ id: result.id, doc_type: result.doc_type, doc_number_last4: result.doc_number_last4, expiry_date: result.expiry_date });
  } catch (err: any) {
    if (err.code === "23505") throw new HttpError(409, "A document with this number already exists");
    throw err;
  }
});

// GET /cif/:id/documents/:docId: Download document (requires login, view module, and logs view)
router.get("/:id/documents/:docId", async (req, res) => {
  const partyId = z.string().regex(/^\d+$/).parse(req.params.id);
  const docId = z.string().regex(/^\d+$/).parse(req.params.docId);

  const { rows } = await pool.query("SELECT file_key FROM party_documents WHERE id = $1 AND party_id = $2", [docId, partyId]);
  if (!rows[0]) throw new HttpError(404, "Document not found");

  const fileKey = rows[0].file_key;
  let buffer: Buffer;
  try {
    buffer = await localDiskStorage.getFile(fileKey);
  } catch (err) {
    throw new HttpError(404, "File missing on disk");
  }

  await tx(async (c) => {
    await audit(c, { userId: req.user!.id, action: "view_document", table: "party_documents", recordId: docId, ip: req.ip });
  });

  const mime = getMagicType(buffer) || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.send(buffer);
});

export default router;
