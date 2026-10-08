import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireSuperAdmin } from "../auth/middleware";
import {
  approveChange, listChanges, listPending, pendingSummary, rejectChange, rejectRecord, verifyRecord,
} from "../makerChecker";

const router = Router();
router.use(requireAuth, requireSuperAdmin);

const recordParams = z.object({ table: z.string(), id: z.string().regex(/^\d+$/) });
const changeParams = z.object({ id: z.string().regex(/^\d+$/) });
const reason = z.object({ reason: z.string().trim().min(3, "Please write a reason").max(500) });

// Badge numbers for the admin menu
router.get("/summary", async (_req, res) => {
  res.json(await pendingSummary());
});

// Staff change and delete requests (must be before "/:table")
router.get("/changes", async (_req, res) => {
  res.json({ changes: await listChanges() });
});
router.post("/changes/:id/approve", async (req, res) => {
  const { id } = changeParams.parse(req.params);
  res.json({ change: await approveChange(req.user!, id, req.ip) });
});
router.post("/changes/:id/reject", async (req, res) => {
  const { id } = changeParams.parse(req.params);
  const { reason: why } = reason.parse(req.body);
  res.json({ change: await rejectChange(req.user!, id, why, req.ip) });
});

// Pending new records
router.get("/:table", async (req, res) => {
  const { table } = z.object({ table: z.string() }).parse(req.params);
  const { limit, offset } = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }).parse(req.query);
  res.json({ records: await listPending(table, limit, offset) });
});
router.post("/:table/:id/verify", async (req, res) => {
  const { table, id } = recordParams.parse(req.params);
  res.json({ record: await verifyRecord(req.user!, table, id, req.ip) });
});
router.post("/:table/:id/reject", async (req, res) => {
  const { table, id } = recordParams.parse(req.params);
  const { reason: why } = reason.parse(req.body);
  res.json({ record: await rejectRecord(req.user!, table, id, why, req.ip) });
});

export default router;
