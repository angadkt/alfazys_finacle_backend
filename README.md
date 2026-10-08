# Financial Management - Backend (steps 1 to 3)

Node.js + TypeScript + Express + PostgreSQL.

## What is inside
- Login with a secure cookie (argon2 password hash, login rate limit)
- Roles: `super_admin` and `staff`; staff permissions per module (none / view / edit)
- Audit log for every important action
- Maker-checker: staff records are `pending` until the super admin verifies them
- Edits to verified records wait for admin approval (the old values stay active)
- Staff cannot delete; they send a delete request
- The database itself blocks direct changes to verified records

## Setup
1. Install Node.js 20+ and PostgreSQL 14+.
2. Create an empty database, for example `finance`.
3. `cp .env.example .env` and fill in `DATABASE_URL`, a long random `JWT_SECRET`, `UPLOAD_DIR` (e.g. `./uploads`), and `DOC_ENCRYPTION_KEY` (must be 32 chars).
4. `npm install`
5. `npm run db:init` (creates all tables from `db/schema.sql`)
6. Create the first super admin:
   `ADMIN_EMAIL=you@example.com ADMIN_NAME="Owner" ADMIN_PASSWORD='a-long-password' npm run seed:admin`
7. Optional: run migrations in `db/migrations/` if the database was already initialized before Step 4.
8. `npm run dev`  (API on http://localhost:3000)

## Main routes
| Method and path | Who | What |
|---|---|---|
| POST /auth/login, /auth/logout | all | Login and logout |
| GET /auth/me | logged in | Current user and permissions |
| POST /auth/change-password | logged in | Change own password |
| GET, POST /users | super admin | List and create users |
| PATCH /users/:id | super admin | Name, active, role |
| PUT /users/:id/permissions | super admin | `{ "financial": "edit", "flat": "view" }` |
| PATCH /records/:table/:id | staff, admin | Edit a record (main fields) |
| DELETE /records/:table/:id | staff, admin | Staff: request. Admin: delete |
| GET /approvals/summary | super admin | Counts for the menu badge |
| GET /approvals/:table | super admin | Pending records of one table |
| POST /approvals/:table/:id/verify | super admin | Verify |
| POST /approvals/:table/:id/reject | super admin | Reject, `{ "reason": "..." }` |
| GET /approvals/changes | super admin | Waiting edit and delete requests |
| POST /approvals/changes/:id/approve, /reject | super admin | Decide a request |
| GET /masters/:table | staff, admin | List master records (active only for staff) |
| POST, PATCH /masters/:table/:id? | super admin | Create, edit or deactivate a master list record |
| GET, POST /cif | staff, admin | List/Search parties (with paging) or Create a new party |
| GET /cif/:id | staff, admin | Get party with all child arrays and documents |
| PATCH /cif/:id/profile | staff, admin | Update nested contacts, addresses, receivers (uses maker-checker) |
| POST /cif/:id/documents | staff, admin | Upload encrypted documents (JPEG, PNG, WebP, PDF) |
| GET /cif/:id/documents/:docId | staff, admin | Download encrypted document |
| GET /cif/missing-documents | staff, admin | List parties missing or with expiring documents |

## For the next steps
- `onVerify`, `afterEdit`, `cleanupOnDelete` hooks are where cash book rows and commissions will be created, fixed, and removed (steps 7 to 10).
- Still to add: lock period (day close) check.
