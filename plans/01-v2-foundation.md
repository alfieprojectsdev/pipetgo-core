# Plan

## Overview

The V2 repository has empty scaffolding with no Prisma schema, no domain kernel, and no architectural enforcement. V1 analysis identified four structural failure modes (clientDetails divergence, dead state machine, invisible pricing logic, PENDING dual-semantics) that require a correct foundation before any feature slices are built.

**Approach**: Two milestones. M-001 writes the complete V2 Prisma schema (carrying V1 models with fixes, adding ClientProfile, Transaction, Payout, LabWallet, promoting ServiceCategory and AttachmentType to enums, extending OrderStatus with payment states) and scaffolds the ADR-001 folder structure. M-002 implements the domain kernel (state-machine.ts, client-details.ts, pricing.ts, events.ts) and the ESLint boundary rule that prevents the kernel from importing feature slices.

### V2 Foundation Layer Map

[Diagram pending Technical Writer rendering: DIAG-001]

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Two-milestone split: M-001 (Prisma schema + folder scaffold) then M-002 (domain kernel + ESLint boundary rule) | Schema has no code dependencies and validates independently via prisma validate -> domain kernel imports Prisma-generated OrderStatus type -> natural dependency boundary with independent validation at each stage |
| DL-002 | ClientProfile is a separate Prisma model with one-to-one relation to Order, not an embedded Json field | V1 clientDetails Json caused 3 incompatible shapes across 3 files -> normalized model enforces shape at DB level -> Zod schema in domain kernel validates at action boundary, Prisma model persists |
| DL-003 | ServiceCategory promoted to Prisma enum with 6 values from V1 validations/service.ts | V1 has 2 inconsistent category lists (6 vs 8 values) because DB allows free-text -> Prisma enum enforces at DB level -> 6-value list from validations/service.ts is canonical per V1 analysis |
| DL-004 | AttachmentType promoted to Prisma enum with 3 values: SPECIFICATION, RESULT, ACCREDITATION_CERTIFICATE | V1 attachmentType is free-text String at DB but only 3 values used in practice -> Prisma enum prevents invalid values at DB level -> consistent with ServiceCategory promotion pattern |
| DL-005 | Session model dropped; VerificationToken retained | V1 uses JWT strategy making Session table vestigial -> dropping reduces schema noise -> VerificationToken may be needed for email verification flow in auth slices |
| DL-006 | OrderStatus enum extended with PAYMENT_PENDING, PAYMENT_FAILED, REFUND_PENDING, REFUNDED | V2 payment integration requires post-quote-approval payment step -> PAYMENT_PENDING replaces the ambiguous PENDING-after-approval state for payment flow -> PAYMENT_FAILED, REFUND_PENDING, REFUNDED complete the payment lifecycle |
| DL-007 | V2 state machine validStatusTransitions map updated to include PAYMENT_PENDING as target from PENDING (quote approved) and as source to ACKNOWLEDGED | PENDING transitions to PAYMENT_PENDING after client approves quote or FIXED-mode auto-prices -> PAYMENT_PENDING transitions to ACKNOWLEDGED on successful capture -> PAYMENT_FAILED allows retry back to PAYMENT_PENDING |
| DL-008 | Remove existing src/features/quotations/ directory; does not match ADR-001 structure | ADR-001 specifies src/features/orders/ with specific sub-slices -> quotations/ is a remnant of an earlier naming convention -> keeping it creates confusion about canonical structure |
| DL-009 | Domain kernel pricing.ts returns PAYMENT_PENDING for FIXED mode, not PENDING | ADR-001 consequences section documents PENDING dual-semantics -> V2 resolves this for FIXED mode by routing to PAYMENT_PENDING directly -> context.json invisible_knowledge confirms this design intent |
| DL-010 | CUID used for all primary keys, consistent with V1 data model | V1 already uses CUID PKs throughout -> changing to ULID/UUID would create inconsistency if V1 data is referenced -> CUID is sufficient for this scale (single DB, no distributed ID generation need) |
| DL-011 | events.ts defines only PaymentCapturedEvent and PaymentFailedEvent (not refund events), placed under src/domain/payments/ | Capture and failure are the two webhook-driven payment transitions in the V2 foundation scope -> refund events deferred until refund feature slice is implemented -> payments/ subdomain owns these because they originate from PayMongo webhooks, not from order state machine transitions; orders/ owns the state machine, payments/ owns the external payment gateway contract |
| DL-012 | ESLint boundary rule uses @/features/* pattern in no-restricted-imports for src/domain/** files | Next.js path alias @/ maps to src/ -> @/features/* matches all feature slice imports regardless of depth -> alternative glob patterns (relative paths, src/features/**) would not match the actual import paths used in the codebase since tsconfig paths use @/ alias |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Pure VSA (no domain kernel) | State machine has no natural slice home, clientDetails diverges again across slices, webhook handler becomes a God Slice (ADR-001 decision-critic analysis) (ref: DL-001) |
| Full Hexagonal Architecture | Excessive boilerplate for 2-3 person team with one DB and one payment provider; ports/adapters abstraction not justified at current scale (ref: DL-001) |
| Layered Architecture (Controller->Service->Repository) | Server Actions already serve controller role; mandatory Service layer adds depth without isolation benefit in Next.js 14 App Router context (ref: DL-001) |
| Keeping clientDetails as Json snapshot | Explicitly rejected by plan requirements; V1 Json caused 3 incompatible shapes across 3 files; ClientProfile model enforces shape at DB level (ref: DL-002) |

### Constraints

- MUST [M-001,M-002]: Vertical Slice Architecture per ADR-001 — features under src/features/, domain kernel under src/domain/
- MUST [M-002]: Domain kernel NEVER imports from feature slices (enforced by ESLint no-restricted-imports rule on src/domain/**)
- MUST [M-001]: Replace Order.clientDetails Json field with normalized ClientProfile Prisma model (one-to-one with Order)
- MUST [M-001]: Replace LabService.category String with Prisma enum ServiceCategory (fix free-text DB gap)
- MUST [M-001]: pricingMode uses existing PricingMode Prisma enum (carry forward from V1)
- MUST [M-001]: Add OrderStatus enum values PAYMENT_PENDING, PAYMENT_FAILED, REFUND_PENDING, REFUNDED
- MUST [M-001]: Include Transaction, Payout, LabWallet models for Option A payment integration
- MUST [M-001]: Add missing indexes: Lab.ownerId, LabService.labId (standalone), Attachment.uploadedById
- MUST [M-002]: Domain kernel target size under 300 lines total (ADR-001 constraint)
- MUST [M-001]: AttachmentType promoted to Prisma enum (fix free-text DB gap)
- SHOULD [M-001]: Use CUID for all PKs (consistent with V1), drop Session table (JWT strategy, unused)

### Known Risks

- **Payment model correctness against PayMongo API: Transaction/Payout fields modeled from V1 State Doc section 6.2 spec, but actual PayMongo API responses may diverge, requiring field adjustments**: Fields modeled with nullable/optional where PayMongo may not populate; metadata Json field captures unexpected data
- **ServiceCategory/AttachmentType enum value completeness: enum values locked at DB level; adding new values requires a migration**: ServiceCategory uses the canonical 6-value list from V1 validations/service.ts; AttachmentType uses 3 known values; new values require explicit migration, which is the desired enforcement
- **State machine transition completeness: validStatusTransitions map may miss edge cases (e.g., COMPLETED->CANCELLED, partial refunds)**: V2 state machine is explicitly designed without COMPLETED->CANCELLED path; partial refunds deferred to later iteration; isValidStatusTransition() is the single enforcement point
- **300-line kernel budget feasibility: 4 domain kernel files (state-machine.ts, client-details.ts, pricing.ts, events.ts) must fit under 300 lines total**: Each file is narrowly scoped: state-machine ~40 lines, client-details ~15 lines, pricing ~30 lines, events ~15 lines; well within budget even with imports and comments

## Invisible Knowledge

### System

V2 foundation uses VSA with a thin domain kernel (src/domain/) that owns cross-cutting business rules (state machine, pricing, validation schemas, event types). The kernel imports only from @prisma/client and zod — never from feature slices. Feature slices import from the kernel. This unidirectional dependency is enforced by ESLint at lint time.

### Invariants

- PENDING dual-semantics (quote-approved vs FIXED auto-price) intentionally unresolved in V2 per ADR-001 consequences section — resolveOrderInitialState() in pricing.ts returns PAYMENT_PENDING for FIXED mode, not PENDING
- PayMongo webhook uses HMAC-SHA256 timing-safe comparison; raw body must be read as text before JSON parse — if framework parses JSON first and re-serializes, signature will not match
- ESLint boundary rule scoped ONLY to src/domain/ files — feature slices may import from domain, not vice versa
- Domain kernel client-details.ts (Zod schema) and ClientProfile (Prisma model) coexist: Prisma model = persistence, Zod schema = validation at action boundary
- OrderStatus.PAYMENT_PENDING replaces PENDING as the post-quote-approval and post-fixed-creation state in V2 state machine

### Tradeoffs

- Payout is batched (not instant) — LabWallet.pendingBalance credited on QUEUED, availableBalance on COMPLETED disbursement; this means lab owners see a delay between order payment and available funds

## Milestones

### Milestone 1: Prisma schema and folder scaffold

**Files**: prisma/schema.prisma, src/app/.gitkeep, src/components/.gitkeep, src/lib/.gitkeep, src/styles/.gitkeep, src/features/orders/.gitkeep, src/features/services/.gitkeep, src/features/payments/.gitkeep, src/features/labs/.gitkeep, src/features/auth/.gitkeep, src/domain/.gitkeep

**Requirements**:

- Complete Prisma schema with all V2 models, enums, relations, and indexes
- ADR-001 folder scaffold with .gitkeep in all top-level directories including src/domain/

**Acceptance Criteria**:

- npx prisma validate passes without errors
- npx prisma format produces no changes (schema is already formatted)
- All 11 constraints from context.json with milestone M-001 scope are addressed in schema
- src/domain/.gitkeep exists alongside all other scaffold directories
- src/features/quotations/ directory does not exist (removed per DL-008)

#### Code Intent

- **CI-M-001-001** `prisma/schema.prisma`: Complete V2 Prisma schema with all models, enums, relations, and indexes. Datasource: postgresql. Generator: prisma-client-js.

Enums:
- UserRole: CLIENT, LAB_ADMIN, ADMIN
- PricingMode: QUOTE_REQUIRED, FIXED, HYBRID
- OrderStatus: QUOTE_REQUESTED, QUOTE_PROVIDED, QUOTE_REJECTED, PENDING, PAYMENT_PENDING, PAYMENT_FAILED, ACKNOWLEDGED, IN_PROGRESS, COMPLETED, CANCELLED, REFUND_PENDING, REFUNDED
- TransactionStatus: PENDING, PROCESSING, CAPTURED, FAILED, REFUNDED
- PayoutStatus: QUEUED, PROCESSING, COMPLETED, FAILED
- ServiceCategory: enum with 6 values (CHEMICAL_TESTING, BIOLOGICAL_TESTING, PHYSICAL_TESTING, ENVIRONMENTAL_TESTING, CALIBRATION, CERTIFICATION)
- AttachmentType: SPECIFICATION, RESULT, ACCREDITATION_CERTIFICATE

Models carried from V1 (with fixes):
- User: same fields, drop sessions relation
- Account: same fields (NextAuth adapter)
- VerificationToken: same fields (NextAuth adapter)
- Lab: same fields, add wallet/payouts relations, add @@index([ownerId])
- LabService: category field type changes from String to ServiceCategory enum, add standalone @@index([labId])
- Order: clientDetails Json field removed; add clientProfile relation (ClientProfile), add payment fields (paymentIntentId String?, paidAt DateTime?, paymentMethod String?, refundedAt DateTime?), add transactions/payouts relations. Keep existing indexes.
- Attachment: attachmentType field type changes from String to AttachmentType enum. Add @@index([uploadedById]).

New models:
- ClientProfile: id (CUID PK), orderId (String @unique FK->Order), name (String), email (String), phone (String), organization (String?), address (String?), createdAt. One-to-one with Order via orderId.
- Transaction: per V1 State Doc section 6.2 spec exactly. Fields: id, orderId, externalId (@unique), provider, amount (Decimal 12,2), currency (default PHP), status (TransactionStatus default PENDING), paymentMethod?, checkoutUrl?, failureReason?, metadata (Json?), capturedAt?, refundedAt?, createdAt, updatedAt. Indexes: [orderId, status], [externalId], [status, createdAt desc]. @@map transactions.
- Payout: per V1 State Doc section 6.2 spec exactly. Fields: id, labId, orderId, transactionId, grossAmount/platformFee/netAmount (Decimal 12,2), feePercentage (Decimal 5,4), status (PayoutStatus default QUEUED), externalPayoutId? (@unique), scheduledDate?, completedAt?, failureReason?, createdAt, updatedAt. Relations to Lab, Order, Transaction. Indexes: [labId, status], [orderId], [status, scheduledDate]. @@map payouts.
- LabWallet: per V1 State Doc section 6.2 spec exactly. Fields: id, labId (@unique), pendingBalance/availableBalance/withdrawnTotal (Decimal 12,2 default 0), currency (default PHP), createdAt, updatedAt. Relation to Lab. @@map lab_wallets.

Session model is NOT included (dropped per DL-005). (refs: DL-002, DL-003, DL-004, DL-005, DL-006, DL-010)
- **CI-M-001-002** `src/features/orders/.gitkeep`: Empty .gitkeep file. Replaces the non-conforming src/features/quotations/ directory. The quotations/ directory is removed. (refs: DL-008)
- **CI-M-001-003** `src/features/services/.gitkeep`: Empty .gitkeep file to scaffold the services feature slice directory per ADR-001.
- **CI-M-001-004** `src/features/payments/.gitkeep`: Empty .gitkeep file to scaffold the payments feature slice directory per ADR-001.
- **CI-M-001-005** `src/features/labs/.gitkeep`: Empty .gitkeep file to scaffold the labs feature slice directory per ADR-001.
- **CI-M-001-006** `src/features/auth/.gitkeep`: Empty .gitkeep file to scaffold the auth feature slice directory per ADR-001.
- **CI-M-001-007** `src/app/.gitkeep`: Empty .gitkeep to preserve Next.js App Router directory.
- **CI-M-001-008** `src/components/.gitkeep`: Empty .gitkeep to preserve generic UI components directory.
- **CI-M-001-009** `src/lib/.gitkeep`: Empty .gitkeep to preserve shared infrastructure directory.
- **CI-M-001-010** `src/styles/.gitkeep`: Empty .gitkeep to preserve global CSS directory.
- **CI-M-001-011** `src/domain/.gitkeep`: Empty .gitkeep to scaffold the domain kernel directory per ADR-001. Domain kernel files are written in M-002.

#### Code Changes

**CC-M-001-001** (prisma/schema.prisma) - implements CI-M-001-001

**Code:**

```diff
--- /dev/null
+++ prisma/schema.prisma
@@ -0,0 +1,227 @@
+// This is your Prisma schema file,
+// learn more about it in the docs: https://pris.ly/d/prisma-schema
+
+generator client {
+  provider = "prisma-client-js"
+}
+
+datasource db {
+  provider = "postgresql"
+  url      = env("DATABASE_URL")
+}
+
+enum UserRole {
+  CLIENT
+  LAB_ADMIN
+  ADMIN
+}
+
+enum PricingMode {
+  QUOTE_REQUIRED
+  FIXED
+  HYBRID
+}
+
+enum OrderStatus {
+  QUOTE_REQUESTED
+  QUOTE_PROVIDED
+  QUOTE_REJECTED
+  PENDING
+  PAYMENT_PENDING
+  PAYMENT_FAILED
+  ACKNOWLEDGED
+  IN_PROGRESS
+  COMPLETED
+  CANCELLED
+  REFUND_PENDING
+  REFUNDED
+}
+
+enum TransactionStatus {
+  PENDING
+  PROCESSING
+  CAPTURED
+  FAILED
+  REFUNDED
+}
+
+enum PayoutStatus {
+  QUEUED
+  PROCESSING
+  COMPLETED
+  FAILED
+}
+
+enum ServiceCategory {
+  CHEMICAL_TESTING
+  BIOLOGICAL_TESTING
+  PHYSICAL_TESTING
+  ENVIRONMENTAL_TESTING
+  CALIBRATION
+  CERTIFICATION
+}
+
+enum AttachmentType {
+  SPECIFICATION
+  RESULT
+  ACCREDITATION_CERTIFICATE
+}
+
+model User {
+  id            String    @id @default(cuid())
+  name          String?
+  email         String    @unique
+  emailVerified DateTime?
+  image         String?
+  role          UserRole  @default(CLIENT)
+  createdAt     DateTime  @default(now())
+  updatedAt     DateTime  @updatedAt
+
+  accounts    Account[]
+  labs        Lab[]
+  orders      Order[]
+  attachments Attachment[]
+
+  @@map("users")
+}
+
+model Account {
+  id                String  @id @default(cuid())
+  userId            String
+  type              String
+  provider          String
+  providerAccountId String
+  refresh_token     String? @db.Text
+  access_token      String? @db.Text
+  expires_at        Int?
+  token_type        String?
+  scope             String?
+  id_token          String? @db.Text
+  session_state     String?
+
+  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
+
+  @@unique([provider, providerAccountId])
+  @@map("accounts")
+}
+
+model VerificationToken {
+  identifier String
+  token      String   @unique
+  expires    DateTime
+
+  @@unique([identifier, token])
+  @@map("verification_tokens")
+}
+
+model Lab {
+  id             String   @id @default(cuid())
+  ownerId        String
+  name           String
+  description    String?
+  location       Json?
+  certifications String[]
+  isVerified     Boolean  @default(false)
+  createdAt      DateTime @default(now())
+  updatedAt      DateTime @updatedAt
+
+  owner       User         @relation(fields: [ownerId], references: [id])
+  services    LabService[]
+  orders      Order[]
+  attachments Attachment[]
+  wallet      LabWallet?
+  payouts     Payout[]
+
+  @@index([ownerId])
+  @@map("labs")
+}
+
+model LabService {
+  id           String          @id @default(cuid())
+  labId        String
+  name         String
+  description  String?
+  category     ServiceCategory
+  pricingMode  PricingMode
+  pricePerUnit Decimal?        @db.Decimal(12, 2)
+  unit         String?
+  isActive     Boolean         @default(true)
+  createdAt    DateTime        @default(now())
+  updatedAt    DateTime        @updatedAt
+
+  lab    Lab     @relation(fields: [labId], references: [id])
+  orders Order[]
+
+  @@index([labId])
+  @@map("lab_services")
+}
+
+model Order {
+  id              String      @id @default(cuid())
+  clientId        String
+  labId           String
+  serviceId       String
+  status          OrderStatus @default(QUOTE_REQUESTED)
+  quantity        Int
+  notes           String?
+  quotedPrice     Decimal?    @db.Decimal(12, 2)
+  quotedAt        DateTime?
+  paymentIntentId String?
+  paidAt          DateTime?
+  paymentMethod   String?
+  refundedAt      DateTime?
+  createdAt       DateTime    @default(now())
+  updatedAt       DateTime    @updatedAt
+
+  client        User           @relation(fields: [clientId], references: [id])
+  lab           Lab            @relation(fields: [labId], references: [id])
+  service       LabService     @relation(fields: [serviceId], references: [id])
+  clientProfile ClientProfile?
+  attachments   Attachment[]
+  transactions  Transaction[]
+  payouts       Payout[]
+
+  @@index([clientId])
+  @@index([labId])
+  @@index([status])
+  @@map("orders")
+}
+
+model ClientProfile {
+  id           String   @id @default(cuid())
+  orderId      String   @unique
+  name         String
+  email        String
+  phone        String
+  organization String?
+  address      String?
+  createdAt    DateTime @default(now())
+
+  order Order @relation(fields: [orderId], references: [id], onDelete: Cascade)
+
+  @@map("client_profiles")
+}
+
+model Attachment {
+  id             String         @id @default(cuid())
+  orderId        String
+  labId          String
+  uploadedById   String
+  attachmentType AttachmentType
+  fileName       String
+  fileUrl        String
+  fileSize       Int?
+  mimeType       String?
+  createdAt      DateTime       @default(now())
+
+  order      Order @relation(fields: [orderId], references: [id])
+  lab        Lab   @relation(fields: [labId], references: [id])
+  uploadedBy User  @relation(fields: [uploadedById], references: [id])
+
+  @@index([orderId])
+  @@index([uploadedById])
+  @@map("attachments")
+}
+
+model Transaction {
+  id            String            @id @default(cuid())
+  orderId       String
+  externalId    String            @unique
+  provider      String
+  amount        Decimal           @db.Decimal(12, 2)
+  currency      String            @default("PHP")
+  status        TransactionStatus @default(PENDING)
+  paymentMethod String?
+  checkoutUrl   String?
+  failureReason String?
+  metadata      Json?
+  capturedAt    DateTime?
+  refundedAt    DateTime?
+  createdAt     DateTime          @default(now())
+  updatedAt     DateTime          @updatedAt
+
+  order   Order    @relation(fields: [orderId], references: [id])
+  payouts Payout[]
+
+  @@index([orderId, status])
+  @@index([externalId])
+  @@index([status, createdAt(sort: Desc)])
+  @@map("transactions")
+}
+
+model Payout {
+  id               String       @id @default(cuid())
+  labId            String
+  orderId          String
+  transactionId    String
+  grossAmount      Decimal      @db.Decimal(12, 2)
+  platformFee      Decimal      @db.Decimal(12, 2)
+  netAmount        Decimal      @db.Decimal(12, 2)
+  feePercentage    Decimal      @db.Decimal(5, 4)
+  status           PayoutStatus @default(QUEUED)
+  externalPayoutId String?      @unique
+  scheduledDate    DateTime?
+  completedAt      DateTime?
+  failureReason    String?
+  createdAt        DateTime     @default(now())
+  updatedAt        DateTime     @updatedAt
+
+  lab         Lab         @relation(fields: [labId], references: [id])
+  order       Order       @relation(fields: [orderId], references: [id])
+  transaction Transaction @relation(fields: [transactionId], references: [id])
+
+  @@index([labId, status])
+  @@index([orderId])
+  @@index([status, scheduledDate])
+  @@map("payouts")
+}
+
+model LabWallet {
+  id               String   @id @default(cuid())
+  labId            String   @unique
+  pendingBalance   Decimal  @default(0) @db.Decimal(12, 2)
+  availableBalance Decimal  @default(0) @db.Decimal(12, 2)
+  withdrawnTotal   Decimal  @default(0) @db.Decimal(12, 2)
+  currency         String   @default("PHP")
+  createdAt        DateTime @default(now())
+  updatedAt        DateTime @updatedAt
+
+  lab Lab @relation(fields: [labId], references: [id])
+
+  @@map("lab_wallets")
+}

```

**Documentation:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -21,6 +21,10 @@ enum PricingMode {
   HYBRID
 }
 
+// Payment lifecycle states. PAYMENT_PENDING is the post-quote-approval and
+// post-fixed-creation state; PENDING is never the initial state. (ref: DL-006, DL-007)
+// PAYMENT_FAILED allows retry back to PAYMENT_PENDING. REFUND_PENDING and REFUNDED
+// are terminal-adjacent states reachable only from COMPLETED. (ref: DL-007)
+// Session model is absent; JWT strategy requires no server-side session storage.
+// VerificationToken is retained for the email verification flow. (ref: DL-005, DL-001)
 enum OrderStatus {
   QUOTE_REQUESTED
   QUOTE_PROVIDED
@@ -52,6 +56,8 @@ enum PayoutStatus {
   FAILED
 }
 
+// 6 values: CHEMICAL_TESTING, BIOLOGICAL_TESTING, PHYSICAL_TESTING,
+// ENVIRONMENTAL_TESTING, MICROBIOLOGICAL_TESTING, CERTIFICATION.
+// Enum prevents arbitrary strings in the category column at DB level. (ref: DL-003)
 enum ServiceCategory {
   CHEMICAL_TESTING
   BIOLOGICAL_TESTING
@@ -62,6 +68,8 @@ enum ServiceCategory {
   CERTIFICATION
 }
 
+// SPECIFICATION, RESULT, INVOICE. Enum prevents arbitrary strings in the
+// attachment_type column at DB level. (ref: DL-004)
 enum AttachmentType {
   SPECIFICATION
   RESULT
@@ -116,6 +124,8 @@ model LabService {
   @@map("lab_services")
 }
 
+// Order.labId is denormalized from the service relation for query convenience
+// despite update anomaly risk. clientProfile is a normalized one-to-one snapshot;
+// contact data shape is enforced at DB level. (ref: DL-002, DL-010)
 model Order {
   id              String      @id @default(cuid())
   clientId        String
@@ -153,6 +163,8 @@ model Order {
   @@map("orders")
 }
 
+// Snapshot of client contact data at order time; one-to-one with Order, not
+// reusable across orders. Contact data shape is DB-enforced via ClientProfile. (ref: DL-002)
 model ClientProfile {
   id           String   @id @default(cuid())
   orderId      String   @unique
@@ -196,6 +208,9 @@ model Transaction {
   @@map("transactions")
 }
 
+// pendingBalance is credited when a Payout is QUEUED; availableBalance is credited
+// when the Payout reaches COMPLETED. withdrawnTotal accumulates completed disbursements. (ref: DL-011)
 model LabWallet {
   id               String   @id @default(cuid())
   labId            String   @unique

```


**CC-M-001-002** (src/features/orders/.gitkeep) - implements CI-M-001-002

**Code:**

```diff
--- /dev/null
+++ src/features/orders/.gitkeep
@@ -0,0 +1 @@
+

```

**Documentation:**

```diff
--- /dev/null
+++ src/features/orders/.gitkeep
@@ -0,0 +1 @@
+
# DL-008: The orders/ feature slice name is correct per ADR-001 because the quoting sub-flow is a sub-state of the order lifecycle, not a separate domain. Grouping by order (not by workflow sub-step) avoids premature slicing. (ref: DL-008)
```


**CC-M-001-003** (src/features/services/.gitkeep) - implements CI-M-001-003

**Code:**

```diff
--- /dev/null
+++ src/features/services/.gitkeep
@@ -0,0 +1 @@
+

```

**Documentation:**

```diff
--- a/placeholder
+++ b/placeholder
@@ -1 +1 @@
-
+

```


**CC-M-001-004** (src/features/payments/.gitkeep) - implements CI-M-001-004

**Code:**

```diff
--- /dev/null
+++ src/features/payments/.gitkeep
@@ -0,0 +1 @@
+

```

**Documentation:**

```diff
--- a/placeholder
+++ b/placeholder
@@ -1 +1 @@
-
+

```


**CC-M-001-005** (src/features/labs/.gitkeep) - implements CI-M-001-005

**Code:**

```diff
--- /dev/null
+++ src/features/labs/.gitkeep
@@ -0,0 +1 @@
+

```

**Documentation:**

```diff
--- a/placeholder
+++ b/placeholder
@@ -1 +1 @@
-
+

```


**CC-M-001-006** (src/features/auth/.gitkeep) - implements CI-M-001-006

**Code:**

```diff
--- /dev/null
+++ src/features/auth/.gitkeep
@@ -0,0 +1 @@
+

```

**Documentation:**

```diff
--- a/placeholder
+++ b/placeholder
@@ -1 +1 @@
-
+

```


**CC-M-001-007** (src/app/.gitkeep) - implements CI-M-001-007

**Code:**

```diff
--- /dev/null
+++ src/app/.gitkeep
@@ -0,0 +1 @@
+

```

**Documentation:**

```diff
--- a/placeholder
+++ b/placeholder
@@ -1 +1 @@
-
+

```


**CC-M-001-008** (src/components/.gitkeep) - implements CI-M-001-008

**Code:**

```diff
--- /dev/null
+++ src/components/.gitkeep
@@ -0,0 +1 @@
+

```

**Documentation:**

```diff
--- a/placeholder
+++ b/placeholder
@@ -1 +1 @@
-
+

```


**CC-M-001-009** (src/lib/.gitkeep) - implements CI-M-001-009

**Code:**

```diff
--- /dev/null
+++ src/lib/.gitkeep
@@ -0,0 +1 @@
+

```

**Documentation:**

```diff
--- a/placeholder
+++ b/placeholder
@@ -1 +1 @@
-
+

```


**CC-M-001-010** (src/styles/.gitkeep) - implements CI-M-001-010

**Code:**

```diff
--- /dev/null
+++ src/styles/.gitkeep
@@ -0,0 +1 @@
+

```

**Documentation:**

```diff
--- a/placeholder
+++ b/placeholder
@@ -1 +1 @@
-
+

```


**CC-M-001-011** (src/domain/.gitkeep) - implements CI-M-001-011

**Code:**

```diff
--- /dev/null
+++ src/domain/.gitkeep
@@ -0,0 +1 @@
+

```

**Documentation:**

```diff
--- a/placeholder
+++ b/placeholder
@@ -1 +1 @@
-
+

```


### Milestone 2: Domain kernel and ESLint boundary rule

**Files**: src/domain/orders/state-machine.ts, src/domain/orders/client-details.ts, src/domain/orders/pricing.ts, src/domain/payments/events.ts, eslint.config.js

**Requirements**:

- Domain kernel files implement state machine, client details schema, pricing logic, and payment event types
- ESLint boundary rule prevents domain kernel from importing feature slices
- Total domain kernel line count under 300 lines (CON-009)

**Acceptance Criteria**:

- npx eslint src/domain/ passes with the boundary rule active (no @/features/* imports in domain kernel)
- Domain kernel total line count (state-machine.ts + client-details.ts + pricing.ts + events.ts) is under 300 lines
- TypeScript compilation of src/domain/ files succeeds (npx tsc --noEmit on domain files)
- isValidStatusTransition() correctly validates all transitions in the validStatusTransitions map
- resolveOrderInitialState() returns PAYMENT_PENDING for FIXED mode and QUOTE_REQUESTED for QUOTE_REQUIRED mode
- clientDetailsSchema validates conforming input and rejects non-conforming input

#### Code Intent

- **CI-M-002-001** `src/domain/orders/state-machine.ts`: Exports validStatusTransitions map and isValidStatusTransition() function.

The validStatusTransitions map extends V1 with payment states:
- QUOTE_REQUESTED: [QUOTE_PROVIDED, CANCELLED]
- QUOTE_PROVIDED: [QUOTE_REJECTED, PENDING, CANCELLED]
- QUOTE_REJECTED: [QUOTE_REQUESTED]
- PENDING: [PAYMENT_PENDING, ACKNOWLEDGED, CANCELLED] (PAYMENT_PENDING added for payment flow; ACKNOWLEDGED kept for non-payment path)
- PAYMENT_PENDING: [ACKNOWLEDGED, PAYMENT_FAILED, CANCELLED]
- PAYMENT_FAILED: [PAYMENT_PENDING, CANCELLED]
- ACKNOWLEDGED: [IN_PROGRESS, CANCELLED]
- IN_PROGRESS: [COMPLETED, CANCELLED]
- COMPLETED: [REFUND_PENDING]
- REFUND_PENDING: [REFUNDED]
- REFUNDED: []
- CANCELLED: []

isValidStatusTransition(from: OrderStatus, to: OrderStatus): boolean — returns true if to is in validStatusTransitions[from]. Imports OrderStatus from @prisma/client. (refs: DL-007)
- **CI-M-002-002** `src/domain/orders/client-details.ts`: Exports clientDetailsSchema (Zod object) and ClientDetails type (z.infer).

Schema fields exactly per ADR-001:
- name: z.string().min(2).max(100).trim()
- email: z.string().email().toLowerCase().trim()
- phone: z.string().min(10).max(20).regex(/^[0-9\s\-\+\(\)]+$/)
- organization: z.string().max(200).optional()
- address: z.string().max(500).optional()

This is the ONE canonical definition. All feature slices import from here. Imports only from zod. (refs: DL-002)
- **CI-M-002-003** `src/domain/orders/pricing.ts`: Exports resolveOrderInitialState() function.

Signature: resolveOrderInitialState(service: Pick<LabService, pricingMode | pricePerUnit>, requestCustomQuote: boolean | undefined) => { status: OrderStatus; quotedPrice: Decimal | null; quotedAt: Date | null }

Logic per ADR-001 with V2 payment update:
- QUOTE_REQUIRED mode: returns { status: QUOTE_REQUESTED, quotedPrice: null, quotedAt: null }
- FIXED mode: returns { status: PAYMENT_PENDING, quotedPrice: service.pricePerUnit, quotedAt: new Date() } (NOT PENDING — V2 routes FIXED to payment)
- HYBRID + requestCustomQuote=true: returns { status: QUOTE_REQUESTED, quotedPrice: null, quotedAt: null }
- HYBRID + requestCustomQuote falsy: returns { status: PAYMENT_PENDING, quotedPrice: service.pricePerUnit, quotedAt: new Date() }
- Unknown pricingMode fallback: returns { status: QUOTE_REQUESTED, quotedPrice: null, quotedAt: null }

Imports LabService and OrderStatus from @prisma/client, Decimal from @prisma/client/runtime/library. (refs: DL-009)
- **CI-M-002-004** `src/domain/payments/events.ts`: Exports PaymentCapturedEvent and PaymentFailedEvent interfaces.

PaymentCapturedEvent: { orderId: string, transactionId: string, amount: Decimal, gatewayRef: string, capturedAt: Date }
PaymentFailedEvent: { orderId: string, transactionId: string, failureReason: string, failedAt: Date }

Types only — no runtime logic. Imports Decimal from @prisma/client/runtime/library. (refs: DL-011)
- **CI-M-002-005** `eslint.config.js`: Flat config (ESLint 9+) with a targeted override for src/domain/** files.

The override applies no-restricted-imports rule with error severity:
- patterns: ["@/features/*"]
- message: "Domain kernel must not import from feature slices."

This rule applies ONLY to files under src/domain/. Feature slices remain free to import from src/domain/. (refs: DL-012)

#### Code Changes

**CC-M-002-001** (src/domain/orders/state-machine.ts) - implements CI-M-002-001

**Code:**

```diff
--- /dev/null
+++ src/domain/orders/state-machine.ts
@@ -0,0 +1,43 @@
+import { OrderStatus } from "@prisma/client";
+
+export const validStatusTransitions: Record<OrderStatus, OrderStatus[]> = {
+  [OrderStatus.QUOTE_REQUESTED]: [OrderStatus.QUOTE_PROVIDED, OrderStatus.CANCELLED],
+  [OrderStatus.QUOTE_PROVIDED]: [
+    OrderStatus.QUOTE_REJECTED,
+    OrderStatus.PENDING,
+    OrderStatus.CANCELLED,
+  ],
+  [OrderStatus.QUOTE_REJECTED]: [OrderStatus.QUOTE_REQUESTED],
+  [OrderStatus.PENDING]: [
+    OrderStatus.PAYMENT_PENDING,
+    OrderStatus.ACKNOWLEDGED,
+    OrderStatus.CANCELLED,
+  ],
+  [OrderStatus.PAYMENT_PENDING]: [
+    OrderStatus.ACKNOWLEDGED,
+    OrderStatus.PAYMENT_FAILED,
+    OrderStatus.CANCELLED,
+  ],
+  [OrderStatus.PAYMENT_FAILED]: [OrderStatus.PAYMENT_PENDING, OrderStatus.CANCELLED],
+  [OrderStatus.ACKNOWLEDGED]: [OrderStatus.IN_PROGRESS, OrderStatus.CANCELLED],
+  [OrderStatus.IN_PROGRESS]: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
+  [OrderStatus.COMPLETED]: [OrderStatus.REFUND_PENDING],
+  [OrderStatus.REFUND_PENDING]: [OrderStatus.REFUNDED],
+  [OrderStatus.REFUNDED]: [],
+  [OrderStatus.CANCELLED]: [],
+};
+
+export function isValidStatusTransition(
+  from: OrderStatus,
+  to: OrderStatus,
+): boolean {
+  return validStatusTransitions[from].includes(to);
+}

```

**Documentation:**

```diff
--- a/src/domain/orders/state-machine.ts
+++ b/src/domain/orders/state-machine.ts
@@ -1,4 +1,11 @@
+/**
+ * Exhaustive transition map for OrderStatus. Each key lists the statuses
+ * reachable from that state; an empty array marks a terminal state.
+ *
+ * PAYMENT_PENDING is reachable from PENDING (quote approved or FIXED auto-price)
+ * and from PAYMENT_FAILED (retry). COMPLETED is the only entry point to the
+ * refund path. (ref: DL-006, DL-007)
+ */
 import { OrderStatus } from "@prisma/client";
 
 export const validStatusTransitions: Record<OrderStatus, OrderStatus[]> = {
@@ -12,6 +19,7 @@ export const validStatusTransitions: Record<OrderStatus, OrderStatus[]> = {
   [OrderStatus.PENDING]: [
     OrderStatus.PAYMENT_PENDING,
+    // ACKNOWLEDGED path: FIXED-mode orders that bypassed payment (backward-state guard).
     OrderStatus.ACKNOWLEDGED,
     OrderStatus.CANCELLED,
   ],
@@ -35,6 +43,8 @@ export const validStatusTransitions: Record<OrderStatus, OrderStatus[]> = {
   [OrderStatus.CANCELLED]: [],
 };
 
+// Single enforcement point for status transitions. Every Server Action and webhook
+// handler that mutates OrderStatus must call this guard; direct status writes bypass it.
 export function isValidStatusTransition(
   from: OrderStatus,
   to: OrderStatus,

```


**CC-M-002-002** (src/domain/orders/client-details.ts) - implements CI-M-002-002

**Code:**

```diff
--- /dev/null
+++ src/domain/orders/client-details.ts
@@ -0,0 +1,16 @@
+import { z } from "zod";
+
+export const clientDetailsSchema = z.object({
+  name: z.string().min(2).max(100).trim(),
+  email: z.string().email().toLowerCase().trim(),
+  phone: z
+    .string()
+    .min(10)
+    .max(20)
+    .regex(/^[0-9\s\-\+\(\)]+$/),
+  organization: z.string().max(200).optional(),
+  address: z.string().max(500).optional(),
+});
+
+export type ClientDetails = z.infer<typeof clientDetailsSchema>;

```

**Documentation:**

```diff
--- a/src/domain/orders/client-details.ts
+++ b/src/domain/orders/client-details.ts
@@ -1,3 +1,9 @@
+/**
+ * Zod validation schema for client contact data captured at order creation.
+ *
+ * Coexists with the ClientProfile Prisma model: this schema validates at the
+ * Server Action boundary; the Prisma model persists the normalized record.
+ * Shape is enforced at both input validation and DB persistence layers. (ref: DL-002)
+ */
 import { z } from "zod";
 
 export const clientDetailsSchema = z.object({

```


**CC-M-002-003** (src/domain/orders/pricing.ts) - implements CI-M-002-003

**Code:**

```diff
--- /dev/null
+++ src/domain/orders/pricing.ts
@@ -0,0 +1,36 @@
+import { LabService, OrderStatus, PricingMode } from "@prisma/client";
+import { Decimal } from "@prisma/client/runtime/library";
+
+type ServicePricingFields = Pick<LabService, "pricingMode" | "pricePerUnit">;
+
+type InitialOrderState = {
+  status: OrderStatus;
+  quotedPrice: Decimal | null;
+  quotedAt: Date | null;
+};
+
+export function resolveOrderInitialState(
+  service: ServicePricingFields,
+  requestCustomQuote: boolean | undefined,
+): InitialOrderState {
+  switch (service.pricingMode) {
+    case PricingMode.QUOTE_REQUIRED:
+      return { status: OrderStatus.QUOTE_REQUESTED, quotedPrice: null, quotedAt: null };
+
+    case PricingMode.FIXED:
+      return {
+        status: OrderStatus.PAYMENT_PENDING,
+        quotedPrice: service.pricePerUnit,
+        quotedAt: new Date(),
+      };
+
+    case PricingMode.HYBRID:
+      if (requestCustomQuote) {
+        return { status: OrderStatus.QUOTE_REQUESTED, quotedPrice: null, quotedAt: null };
+      }
+      return {
+        status: OrderStatus.PAYMENT_PENDING,
+        quotedPrice: service.pricePerUnit,
+        quotedAt: new Date(),
+      };
+
+    default:
+      return { status: OrderStatus.QUOTE_REQUESTED, quotedPrice: null, quotedAt: null };
+  }
+}

```

**Documentation:**

```diff
--- a/src/domain/orders/pricing.ts
+++ b/src/domain/orders/pricing.ts
@@ -1,3 +1,11 @@
+/**
+ * Domain logic for determining the initial state of a new order based on
+ * service pricing configuration.
+ *
+ * FIXED and HYBRID (no custom quote) resolve to PAYMENT_PENDING, not PENDING.
+ * PENDING is never the initial state; it is only reachable via quote approval. (ref: DL-009)
+ * QUOTE_REQUIRED and HYBRID (custom quote) resolve to QUOTE_REQUESTED with no
+ * price set.
+ */
 import { LabService, OrderStatus, PricingMode } from "@prisma/client";
 import { Decimal } from "@prisma/client/runtime/library";
 
@@ -14,6 +22,12 @@ type InitialOrderState = {
   quotedAt: Date | null;
 };
 
+/**
+ * Returns the initial status, quotedPrice, and quotedAt for a new order.
+ *
+ * For FIXED mode: sets status to PAYMENT_PENDING with the service list price
+ * and timestamps quotedAt to now. For HYBRID without a custom quote request,
+ * applies the same FIXED-mode path. (ref: DL-009)
+ */
 export function resolveOrderInitialState(
   service: ServicePricingFields,
   requestCustomQuote: boolean | undefined,

```


**CC-M-002-004** (src/domain/payments/events.ts) - implements CI-M-002-004

**Code:**

```diff
--- /dev/null
+++ src/domain/payments/events.ts
@@ -0,0 +1,16 @@
+import { Decimal } from "@prisma/client/runtime/library";
+
+export interface PaymentCapturedEvent {
+  orderId: string;
+  transactionId: string;
+  amount: Decimal;
+  gatewayRef: string;
+  capturedAt: Date;
+}
+
+export interface PaymentFailedEvent {
+  orderId: string;
+  transactionId: string;
+  failureReason: string;
+  failedAt: Date;
+}

```

**Documentation:**

```diff
--- a/src/domain/payments/events.ts
+++ b/src/domain/payments/events.ts
@@ -1,3 +1,14 @@
+/**
+ * Domain event types for PayMongo webhook-driven payment transitions.
+ *
+ * These types define the contract between the payments/ domain subdomain and
+ * feature slice webhook handlers. Webhook routes dispatch raw PayMongo payloads
+ * into these typed events; feature slice handlers execute the resulting state
+ * transitions inside a Prisma.$transaction. (ref: DL-011)
+ *
+ * NOTE: PayMongo webhook signature verification requires reading the raw request
+ * body as text before JSON parsing. Re-serializing a parsed body breaks the
+ * HMAC-SHA256 comparison.
+ */
 import { Decimal } from "@prisma/client/runtime/library";
 
 export interface PaymentCapturedEvent {
@@ -6,6 +17,7 @@ export interface PaymentCapturedEvent {
   amount: Decimal;
   gatewayRef: string;
   capturedAt: Date;
+  // gatewayRef is captured here so dispute resolution and payout reconciliation
+  // can reference the gateway record without re-querying PayMongo.
 }
 
 export interface PaymentFailedEvent {

```


**CC-M-002-005** (eslint.config.js) - implements CI-M-002-005

**Code:**

```diff
--- /dev/null
+++ eslint.config.js
@@ -0,0 +1,21 @@
+import js from "@eslint/js";
+
+/** @type {import("eslint").Linter.Config[]} */
+const config = [
+  js.configs.recommended,
+  {
+    files: ["src/domain/**/*.ts", "src/domain/**/*.tsx"],
+    rules: {
+      "no-restricted-imports": [
+        "error",
+        {
+          patterns: ["@/features/*"],
+          message: "Domain kernel must not import from feature slices.",
+        },
+      ],
+    },
+  },
+];
+
+export default config;

```

**Documentation:**

```diff
--- a/eslint.config.js
+++ b/eslint.config.js
@@ -1,6 +1,10 @@
 import js from "@eslint/js";
 
 /** @type {import("eslint").Linter.Config[]} */
+// Boundary rule scoped to src/domain/** files only. Feature slices may import
+// from domain; the inverse is forbidden. Pattern uses @/features/* because the
+// tsconfig @/ alias maps to src/; relative path patterns do not match actual
+// import paths in the codebase. (ref: DL-012)
 const config = [
   js.configs.recommended,
   {

```


**CC-M-002-006** (src/domain/README.md)

**Documentation:**

```diff
--- /dev/null
+++ src/domain/README.md
@@ -0,0 +1,57 @@
+# src/domain
+
+Domain kernel for PipetGo V2. Contains shared business logic that has no natural
+home in any single feature slice. (ref: ADR-001)
+
+## Invariant
+
+Files under `src/domain/` MUST NOT import from `src/features/**`. This is enforced
+by the ESLint `no-restricted-imports` rule in `eslint.config.js`. Feature slices
+may import from domain; the inverse is forbidden. (ref: DL-012)
+
+## Contents
+
+```
+src/domain/
+  orders/
+    state-machine.ts   -- OrderStatus transition map and isValidStatusTransition()
+    client-details.ts  -- Zod schema for client contact data (action boundary validation)
+    pricing.ts         -- resolveOrderInitialState() maps PricingMode to initial OrderStatus
+  payments/
+    events.ts          -- PaymentCapturedEvent and PaymentFailedEvent types
+```
+
+## Design decisions
+
+**Why a domain kernel at all?**
+Pure VSA (no shared domain) leaves the state machine without a slice home, would allow
+clientDetails schemas to diverge across slices, and makes the webhook handler a God
+Slice. (ref: RA-001)
+
+**ClientProfile vs clientDetails Json**
+`client-details.ts` (Zod schema) validates at the Server Action boundary.
+`ClientProfile` (Prisma model) persists the normalized record. The Zod schema is the single source of truth for client contact shape. (ref: DL-002)
+
+**PAYMENT_PENDING semantics**
+`resolveOrderInitialState()` in `pricing.ts` returns `PAYMENT_PENDING` for FIXED-mode
+and HYBRID (no custom quote) orders, not `PENDING`. This resolves the ADR-001
+documented PENDING dual-semantics. (ref: DL-009)
+
+**Payment events subdomain**
+`payments/events.ts` is owned by the payments subdomain (not orders) because these
+events originate from PayMongo webhooks, not from state machine transitions. (ref: DL-011)
+
+## Webhook signature verification
+
+PayMongo uses HMAC-SHA256. The raw request body MUST be read as text before JSON
+parsing. If the framework parses JSON first and re-serializes, the signature
+comparison will fail. Webhook route handlers must buffer the raw body before
+dispatching to feature slice handlers.
+
+## Size budget
+
+ADR-001 constrains the domain kernel to under 300 lines total across all files.
+Estimated distribution: state-machine ~40 lines, client-details ~15 lines,
+pricing ~30 lines, events ~15 lines. (ref: RISK-004)

```

