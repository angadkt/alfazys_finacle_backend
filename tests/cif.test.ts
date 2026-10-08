import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/app";
import { pool, tx } from "../src/db";
import { makerFields } from "../src/makerChecker";
import { encryptDocNumber } from "../src/services/crypto";
import jwt from "jsonwebtoken";

// Mock the db and crypto to avoid needing a real db or secret
vi.mock("../src/db", () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue({ release: vi.fn() })
  },
  tx: vi.fn(async (cb) => {
    const mockClient = { query: vi.fn().mockResolvedValue({ rows: [{ id: "1" }] }) };
    return cb(mockClient);
  }),
}));

vi.mock("../src/audit", () => ({ audit: vi.fn() }));
vi.mock("../src/services/storage", () => ({
  localDiskStorage: {
    saveFile: vi.fn().mockResolvedValue("test_key.jpg"),
    getFile: vi.fn().mockResolvedValue(Buffer.from("fake data")),
  }
}));
vi.mock("jsonwebtoken", () => ({
  default: {
    verify: vi.fn().mockReturnValue({ sub: "1" })
  }
}));

describe("CIF & Master Rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. Staff cannot verify - Maker Checker", () => {
    const staffUser: any = { id: "1", role: "staff" };
    const adminUser: any = { id: "2", role: "super_admin" };
    
    expect(makerFields(staffUser).status).toBe("pending");
    expect(makerFields(adminUser).status).toBe("verified");
  });

  it("2. Staff without access gets 403", async () => {
    const mockPool = pool as any;
    // user query
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: "1", is_active: true, role: "staff" }] });
    // permissions query - none for financial
    mockPool.query.mockResolvedValueOnce({ rows: [{ module: "financial", level: "none" }] });

    const res = await request(app)
      .post("/cif")
      .set("Cookie", ["token=valid_token"])
      .send({
        kind: "customer", first_name: "John", contact_number: "123", addresses: [{
          address_format: "1", address_type: "Home", house_no: "1", street_no: "1", street_name: "A", city: "Dubai", state: "DXB", country: "UAE", postal_code: "00000", valid_from: "2023-01-01"
        }]
      });
    
    expect(res.status).toBe(403);
    expect(res.body.error).toContain("do not have access");
  });

  it("3. Duplicate phone gives a clear error", async () => {
    const mockPool = pool as any;
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: "1", is_active: true, role: "super_admin" }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ module: "financial", level: "edit" }] });

    const mockTx = tx as any;
    mockTx.mockRejectedValueOnce(Object.assign(new Error(), { code: "23505" }));

    const res = await request(app)
      .post("/cif")
      .set("Cookie", ["token=valid_token"])
      .send({
        kind: "customer", first_name: "John", contact_number: "duplicate_phone", addresses: [{
          address_format: "1", address_type: "Home", house_no: "1", street_no: "1", street_name: "A", city: "Dubai", state: "DXB", country: "UAE", postal_code: "00000", valid_from: "2023-01-01"
        }]
      });
    
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("contact number already exists");
  });

  it("4. Invalid file type is rejected", async () => {
    const mockPool = pool as any;
    mockPool.query.mockResolvedValueOnce({ rows: [{ id: "1", is_active: true, role: "super_admin" }] });
    mockPool.query.mockResolvedValueOnce({ rows: [{ module: "financial", level: "edit" }] });

    const res = await request(app)
      .post("/cif/1/documents")
      .set("Cookie", ["token=valid_token"])
      .field("doc_type", "photo")
      .attach("file", Buffer.from("this is a text file, not an image"), "test.txt");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid file type");
  });

  it("5. Masked numbers works properly for docs", () => {
    const res = encryptDocNumber("1234567890ABCDEF");
    expect(res.doc_number_last4).toBe("****CDEF");
    expect(res.doc_number_enc).toBeTypeOf("string");
    expect(res.doc_number_hash).toBeTypeOf("string");
  });
});
