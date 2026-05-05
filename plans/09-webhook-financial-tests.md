# Plan

## Overview

processPaymentCapture handles financial ledger operations (LabWallet crediting, idempotency, transactional atomicity) with no automated test coverage. Production deployment risks undetected regressions in payment capture, double-credit, or rollback behavior.

**Approach**: Install Vitest with vite-tsconfig-paths, then create an integration test file with 4 test cases exercising processPaymentCapture against a real test database (wallet creation, balance increment, idempotency guard) and a Prisma mock (rollback error propagation).

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Vitest over Jest for test framework | package.json type:module -> ESM-first project -> Jest requires complex babel/SWC + moduleNameMapper for @/* aliases -> Vitest is native ESM with vite-tsconfig-paths plugin -> lower config surface, idiomatic choice |
| DL-002 | Real test database for tests 1-3, Prisma mock for test 4 | Financial ledger correctness requires DB-level verification -> mocked Prisma hides real constraint/type issues -> real DB catches Decimal handling and FK constraint bugs; test 4 (rollback) cannot force tx.labWallet.upsert failure on real DB without schema changes -> mock is the only viable approach for error propagation verification |
| DL-003 | Inline test PrismaClient in test file, not shared test-utils | Scope is one test file -> extracting shared utils is YAGNI -> inline keeps test self-contained -> extract to shared module when second test file appears |
| DL-004 | vi.mock of @/lib/prisma to inject test client | processPaymentCapture imports prisma from @/lib/prisma -> vi.mock replaces module-level import -> test client with DATABASE_TEST_URL reaches the function under test -> no source code changes needed |
| DL-005 | Decimal assertions via toFixed string comparison | Transaction.amount is Prisma Decimal -> JavaScript === fails on Decimal objects -> .toFixed(2) converts to deterministic string -> string comparison is reliable across Prisma versions |
| DL-006 | Separate test file for rollback mock test (test 4) instead of dual-mode mocking in single file | Tests 1-3 use vi.mock to inject a real PrismaClient (DATABASE_TEST_URL) -> test 4 needs a fully mocked Prisma with vi.fn() stubs -> vi.mock is hoisted and module-scoped, so a single vi.mock factory cannot serve both real client and full mock without fragile vi.resetModules or conditional factory logic -> separate file (handlers-rollback.test.ts) gives test 4 its own vi.mock scope with clean full-mock factory -> simpler, no switching mechanism needed, each file has one mocking strategy |
| DL-007 | dotenv loading via vitest.config.ts envFile for DATABASE_TEST_URL | Tests need DATABASE_TEST_URL -> vitest supports envFile option natively -> .env.test file at project root with DATABASE_TEST_URL -> no dotenv dependency needed -> if envFile missing, PrismaClient falls back to DATABASE_URL (production DB) which is catastrophic -> vitest.config.ts setupFiles script validates DATABASE_TEST_URL is defined before tests run |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Jest for test framework | Next.js 14 'type': 'module' requires babel/SWC transforms + complex moduleNameMapper for path aliases; Vitest is the idiomatic ESM-first choice (ref: DL-001) |
| Mocking Prisma for tests 1-3 | User explicitly requires real DB for financial ledger verification; mocked tests that passed while prod failed is the exact anti-pattern being guarded against (ref: DL-002) |
| Proxy-based real DB rollback test for test 4 | Requires vi.spyOn(prisma, '$transaction') wrapping realTx in a Proxy to intercept tx.labWallet.upsert; complex, fragile (Proxy over Prisma interactive tx client is not well-supported), unnecessary given Prisma/Postgres atomicity guarantee (ref: DL-002) |
| jest-mock-extended / prisma-mock for test 4 | Additional dependency that duplicates what vi.fn() already provides; not warranted for 4 tests (ref: DL-002) |
| Single test file with vi.resetModules or conditional vi.mock factory for dual-mode mocking | vi.mock is hoisted and module-scoped; conditional factory adds complexity and fragility; vi.resetModules requires re-importing everything per describe block; separate files are simpler and each file has exactly one mocking strategy (ref: DL-006) |

### Constraints

- MUST: output file is src/features/payments/webhooks/__tests__/handlers.test.ts (real DB tests) and handlers-rollback.test.ts (mock test)
- MUST: test processPaymentCapture (exported from handlers.ts), not handlePaymentCaptured (internal orders slice fn)
- MUST: 4 test cases — (1) first payment creates wallet with correct pendingBalance, (2) subsequent payment increments pendingBalance, (3) idempotency: duplicate webhook for CAPTURED transaction returns without double-credit, (4) rollback: wallet credit failure causes Transaction + Order updates to roll back
- MUST: use Vitest (Next.js 14 with 'type': 'module' makes Jest ESM setup extremely complex; Vitest is native ESM)
- MUST: tests 1-3 hit a real test database (strict verification of financial ledgers; mocking Prisma defeats purpose)
- MUST: test 4 (rollback) uses a full Prisma mock — impossible to force tx.labWallet.upsert to fail on real DB without schema changes
- MUST: vitest.config.ts configures vite-tsconfig-paths for @/* alias resolution
- SHOULD: beforeEach cleanup deletes test data using prisma.deleteMany in dependency order

### Known Risks

- **DATABASE_TEST_URL not set or pointing to production database**: vitest.config.ts setupFiles includes a guard script that throws if DATABASE_TEST_URL is undefined or empty; .env.test file documents the expected variable
- **Test isolation failure — leftover data from previous test run**: beforeEach cleanup deletes all test data by known test IDs in FK-dependency order before each test seeds fresh data
- **Decimal handling mismatch between assertion and Prisma Decimal type**: DL-005: all pendingBalance assertions use .toFixed(2) string comparison, never === on Decimal objects

## Invisible Knowledge

### System

processPaymentCapture uses prisma.$transaction interactive mode; all 6 operations (findFirst, status check, transaction.update, handlePaymentCaptured, order.findUnique, labWallet.upsert) are inside the callback

### Invariants

- Transaction.amount is Prisma Decimal — pendingBalance assertions must use .toFixed() or .equals(), not === with number literals
- Order requires clientId (User), labId (Lab), serviceId (LabService) — seed data must create all four models in dependency order
- Transaction.externalId @unique — each test must use a distinct externalId or cleanup must delete between tests
- beforeEach cleanup order: LabWallet, Transaction, Order, ClientProfile, LabService, Lab, User — FK constraints require this delete order
- processPaymentCapture idempotency guard checks Transaction.status===CAPTURED (not Order.status) — test 3 must seed Transaction with status=CAPTURED
- handlePaymentCaptured throws (not returns) on missing Order or invalid transition — error propagates out of $transaction causing Prisma rollback
- Next.js 14 with 'type': 'module' in package.json — vitest.config.ts must use ES module export syntax (no CommonJS)
- Test DB schema must be pushed before integration tests run — globalSetup runs 'prisma db push' with DATABASE_URL overridden to DATABASE_TEST_URL; without this, integration tests silently fail on missing tables

### Tradeoffs

- Split test files (handlers.test.ts + handlers-rollback.test.ts) adds a second file but eliminates dual-mode mock complexity entirely
- Real DB tests are slower than mocks but catch Decimal/FK/constraint bugs that mocks would miss

## Milestones

### Milestone 1: Vitest tooling setup

**Files**: vitest.config.ts, package.json, .env.test, src/test/global-setup.ts

**Acceptance Criteria**:

- npx vitest --run exits 0 with no test files (framework installed correctly)
- vitest.config.ts resolves @/* aliases via vite-tsconfig-paths plugin
- vitest.config.ts configures globalSetup pointing to src/test/global-setup.ts
- global-setup.ts runs prisma db push against DATABASE_TEST_URL before tests execute
- package.json contains 'test' script that invokes vitest
- .env.test contains DATABASE_TEST_URL placeholder

#### Code Intent

- **CI-M-001-001** `package.json`: Add vitest and vite-tsconfig-paths to devDependencies (vitest ^3.0.0, vite-tsconfig-paths ^5.0.0). Add a 'test' script to the scripts section: "test": "vitest" (runs in watch mode by default; CI uses vitest --run). (refs: DL-001)
- **CI-M-001-002** `vitest.config.ts`: Export a Vitest config using defineConfig from vitest/config and vite-tsconfig-paths plugin. Uses ES module export syntax (no CommonJS). The tsconfigPaths plugin resolves @/* aliases from tsconfig.json. No test globals — tests import describe/it/expect from vitest explicitly. Configure setupFiles to include a setup script (src/test/setup.ts) that validates DATABASE_TEST_URL is defined and non-empty, throwing an error if missing to prevent accidental production DB usage. Configure globalSetup to include src/test/global-setup.ts which runs 'prisma db push' against the test database to ensure the schema is up-to-date before any tests execute — this prevents silent integration test failures from stale schema. (refs: DL-001, DL-007)
- **CI-M-001-003** `.env.test`: Create .env.test at project root with DATABASE_TEST_URL placeholder (commented example showing postgresql://... format). This file is loaded by the developer manually or via dotenv in the setup script. Add .env.test to .gitignore if not already covered by .env* pattern. (refs: DL-007)
- **CI-M-001-004** `src/test/setup.ts`: Vitest setup file that loads dotenv from .env.test (using dotenv/config with path override to .env.test) and validates that DATABASE_TEST_URL is defined and non-empty. Throws a descriptive error ('DATABASE_TEST_URL must be set in .env.test — refusing to run tests without it to prevent production DB usage') if missing. This file runs before any test file. (refs: DL-007)
- **CI-M-001-005** `src/test/global-setup.ts`: Vitest globalSetup file that runs before any test file loads. Loads .env.test via dotenv (same as setup.ts) to get DATABASE_TEST_URL, then executes 'npx prisma db push --skip-generate' with DATABASE_URL overridden to DATABASE_TEST_URL via child_process.execSync. This ensures the test database schema matches the current prisma/schema.prisma before integration tests run. If prisma db push fails (non-zero exit), the error propagates and vitest aborts — preventing tests from running against a stale or empty schema. Uses execSync (not async) because globalSetup supports synchronous execution and simplicity matters here. (refs: DL-002, DL-007)

#### Code Changes

**CC-M-001-001** (package.json) - implements CI-M-001-001

**Code:**

```diff
--- a/package.json
+++ b/package.json
@@ -4,6 +4,9 @@
   "private": true,
   "type": "module",
+  "scripts": {
+    "test": "vitest"
+  },
   "dependencies": {
@@ -19,6 +22,10 @@
     "prisma": "^5.22.0",
     "typescript": "^5.0.0",
-    "typescript-eslint": "^8.0.0"
+    "typescript-eslint": "^8.0.0",
+    "dotenv": "^16.0.0",
+    "vite-tsconfig-paths": "^5.0.0",
+    "vitest": "^3.0.0"
   }
 }
```

**Documentation:**

```diff
--- a/package.json
+++ b/package.json
@@ -1,5 +1,14 @@
 {
+  // "test" script: vitest runs in watch mode locally; CI passes --run for one-shot execution.
+  // vitest chosen over Jest because 'type': 'module' makes Jest ESM setup require babel/SWC
+  // transforms and complex moduleNameMapper for @/* aliases. (ref: DL-001)
+  "scripts": {
+    "test": "vitest"
+  },
   "devDependencies": {
+    // vitest ^3.0.0 — test framework; vite-tsconfig-paths ^5.0.0 — resolves @/* aliases
+    // from tsconfig.json inside vitest worker processes without separate config. (ref: DL-001)
+    // dotenv ^16.0.0 — loaded by src/test/setup.ts and global-setup.ts to read .env.test;
+    // required because vitest envFile option alone does not load env into child processes
+    // spawned by globalSetup. (ref: DL-007)
+    "vitest": "^3.0.0",
+    "vite-tsconfig-paths": "^5.0.0",
+    "dotenv": "^16.0.0"
   }
 }

```


**CC-M-001-002** (vitest.config.ts) - implements CI-M-001-002

**Code:**

```diff
--- /dev/null
+++ b/vitest.config.ts
@@ -0,0 +1,11 @@
+import { defineConfig } from 'vitest/config'
+import tsconfigPaths from 'vite-tsconfig-paths'
+
+export default defineConfig({
+  plugins: [tsconfigPaths()],
+  test: {
+    environment: 'node',
+    setupFiles: ['src/test/setup.ts'],
+    globalSetup: ['src/test/global-setup.ts'],
+  },
+})
```

**Documentation:**

```diff
--- a/vitest.config.ts
+++ b/vitest.config.ts
@@ -0,0 +1,16 @@
+// Vitest configuration for PipetGo integration tests.
+// Uses Vitest instead of Jest because package.json declares "type": "module" — Jest requires
+// complex babel/SWC transforms and moduleNameMapper for @/* aliases in ESM projects. (ref: DL-001)
+// vite-tsconfig-paths resolves @/* aliases declared in tsconfig.json without additional config. (ref: DL-001)
+import { defineConfig } from 'vitest/config'
+import tsconfigPaths from 'vite-tsconfig-paths'
+
+export default defineConfig({
+  plugins: [tsconfigPaths()], // resolves @/* → src/* from tsconfig paths (ref: DL-001)
+  test: {
+    environment: 'node',
+    setupFiles: ['src/test/setup.ts'],     // per-worker: loads .env.test and guards DATABASE_TEST_URL (ref: DL-007)
+    globalSetup: ['src/test/global-setup.ts'], // once per run: pushes schema to test DB (ref: DL-007)
+  },
+})

```


**CC-M-001-003** (.env.test) - implements CI-M-001-003

**Code:**

```diff
--- /dev/null
+++ b/.env.test
@@ -0,0 +1,4 @@
+# Test database connection — must point to a separate test database, NOT production.
+# Copy this file and set the value before running tests.
+# Example: postgresql://postgres:password@localhost:5432/pipetgo_test
+DATABASE_TEST_URL=
```

**Documentation:**

```diff
--- /dev/null
+++ b/.env.test
@@ -0,0 +1,7 @@
+# DATABASE_TEST_URL — required before running any integration tests.
+#
+# Must point to a dedicated test database, NOT the production or development DATABASE_URL.
+# If this variable is unset, PrismaClient falls back to DATABASE_URL, which would execute
+# destructive test cleanup (deleteMany) against production data. (ref: R-001, DL-007)
+#
+# Example: postgresql://postgres:password@localhost:5432/pipetgo_test
+DATABASE_TEST_URL=

```


**CC-M-001-004** (src/test/setup.ts) - implements CI-M-001-004

**Code:**

```diff
--- /dev/null
+++ b/src/test/setup.ts
@@ -0,0 +1,11 @@
+import { config } from 'dotenv'
+import path from 'path'
+
+config({ path: path.resolve(process.cwd(), '.env.test') })
+
+if (!process.env.DATABASE_TEST_URL) {
+  throw new Error(
+    'DATABASE_TEST_URL must be set in .env.test — ' +
+      'refusing to run tests without it to prevent production DB usage',
+  )
+}
```

**Documentation:**

```diff
--- a/src/test/setup.ts
+++ b/src/test/setup.ts
@@ -0,0 +1,14 @@
+// Per-worker setup file: loads .env.test into process.env before each test worker starts.
+// Runs inside each worker process — ensures DATABASE_TEST_URL is visible to PrismaClient
+// instantiated in test files. (ref: DL-007)
+import { config } from 'dotenv'
+import path from 'path'
+
+config({ path: path.resolve(process.cwd(), '.env.test') })
+
+// Hard stop if DATABASE_TEST_URL is unset — a missing value causes PrismaClient to fall back
+// to DATABASE_URL (production), which would corrupt production data. (ref: R-001, DL-007)
+if (!process.env.DATABASE_TEST_URL) {
+  throw new Error(
+    'DATABASE_TEST_URL must be set in .env.test — ' +
+      'refusing to run tests without it to prevent production DB usage',
+  )
+}

```


**CC-M-001-005** (src/test/global-setup.ts) - implements CI-M-001-005

**Code:**

```diff
--- /dev/null
+++ b/src/test/global-setup.ts
@@ -0,0 +1,17 @@
+import { config } from 'dotenv'
+import path from 'path'
+import { execSync } from 'child_process'
+
+export default function setup() {
+  config({ path: path.resolve(process.cwd(), '.env.test') })
+
+  const testUrl = process.env.DATABASE_TEST_URL
+  if (!testUrl) {
+    throw new Error('DATABASE_TEST_URL must be set in .env.test')
+  }
+
+  execSync('npx prisma db push --skip-generate', {
+    env: { ...process.env, DATABASE_URL: testUrl },
+    stdio: 'inherit',
+  })
+}
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/test/global-setup.ts
@@ -0,0 +1,22 @@
+// Global setup: runs once per test run (not per worker) before any test file executes.
+// Pushes the current Prisma schema to the test database so integration tests run against
+// a consistent schema. Without this step, missing tables cause silent integration test failures
+// (Prisma throws on unknown table instead of a meaningful test error). (ref: DL-007)
+import { config } from 'dotenv'
+import path from 'path'
+import { execSync } from 'child_process'
+
+// Loads .env.test to resolve DATABASE_TEST_URL before any globalSetup logic runs.
+// globalSetup runs in the main process, not a worker — setup.ts (per-worker) has not run yet.
+export default function setup() {
+  config({ path: path.resolve(process.cwd(), '.env.test') })
+
+  const testUrl = process.env.DATABASE_TEST_URL
+  // Guard: if DATABASE_TEST_URL is unset, PrismaClient defaults to DATABASE_URL (production).
+  // Abort here rather than silently push schema changes to the production database. (ref: R-001)
+  if (!testUrl) {
+    throw new Error('DATABASE_TEST_URL must be set in .env.test — refusing to proceed without it to prevent production DB modification')
+  }
+
+  // Overrides DATABASE_URL with the test URL so prisma db push targets the test DB, not production.
+  // --skip-generate avoids regenerating the Prisma client on every test run. (ref: DL-007)
+  execSync('npx prisma db push --skip-generate', {
+    env: { ...process.env, DATABASE_URL: testUrl },
+    stdio: 'inherit',
+  })
+}

```


**CC-M-001-006** (src/features/payments/webhooks/CLAUDE.md)

**Documentation:**

```diff
--- a/src/features/payments/webhooks/CLAUDE.md
+++ b/src/features/payments/webhooks/CLAUDE.md
@@ -12,4 +12,6 @@
 | File          | Contents (WHAT)                                                                                  | Read When (WHEN)                                              |
 | ------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
 | `route.ts`    | Next.js route handler; x-callback-token verification; status filtering                          | Modifying webhook auth or adding new Xendit event types       |
 | `handlers.ts` | `processPaymentCapture` — Transaction CAPTURED update, Order fan-out, LabWallet credit (atomic) | Modifying payment capture logic or LabWallet crediting        |
 | `types.ts`    | `XenditInvoicePayload` — webhook request body shape                                              | Adding fields from Xendit payload or modifying type contracts |
 | `README.md`   | Request flow, two-ID scheme, invariants, idempotency design                                      | Understanding capture lifecycle or debugging webhook behavior |
+| `__tests__/handlers.test.ts` | processPaymentCapture integration tests (tests 1-3) — real test database: wallet creation, balance increment, idempotency | Running or modifying integration tests for payment capture |
+| `__tests__/handlers-rollback.test.ts` | processPaymentCapture rollback test (test 4) — full Prisma mock: wallet upsert failure error propagation | Running or modifying the rollback error propagation test |

```


**CC-M-001-007** (src/features/payments/CLAUDE.md)

**Documentation:**

```diff
--- a/src/features/payments/CLAUDE.md
+++ b/src/features/payments/CLAUDE.md
@@ -8,4 +8,4 @@
 | Directory    | What                                                                       | When to read                                              |
 | ------------ | -------------------------------------------------------------------------- | --------------------------------------------------------- |
 | `checkout/`  | Deferred-payment checkout — Xendit invoice creation and redirect           | Implementing or modifying the PAYMENT_PENDING pay flow    |
-| `webhooks/`  | Xendit invoice webhook — verifies x-callback-token, marks Transaction CAPTURED, dispatches to order handler, credits LabWallet.pendingBalance | Implementing or modifying webhook payment capture or lab wallet crediting |
+| `webhooks/`  | Xendit invoice webhook — verifies x-callback-token, marks Transaction CAPTURED, dispatches to order handler, credits LabWallet.pendingBalance; integration tests in `webhooks/__tests__/` | Implementing or modifying webhook payment capture, lab wallet crediting, or payment capture tests |

```


**CC-M-001-008** (src/features/CLAUDE.md)

**Documentation:**

```diff
--- a/src/features/CLAUDE.md
+++ b/src/features/CLAUDE.md
@@ -8,6 +8,6 @@
 | Directory  | What                                       | When to read                                      |
 | ---------- | ------------------------------------------ | ------------------------------------------------- |
 | `orders/`  | Order creation and management slices       | Implementing any order flow                       |
 | `auth/`    | Authentication UI and flows                | Modifying sign-in, sign-out, or session handling  |
 | `labs/`    | Lab profile and listing slices             | Implementing lab-facing or marketplace features   |
-| `payments/`| Payment flow slices                        | Implementing checkout or payment status pages     |
+| `payments/`| Payment flow slices; webhook slice includes integration tests in `payments/webhooks/__tests__/` | Implementing checkout or payment status pages, or running payment capture integration tests |
 | `services/`| Lab service listing and detail slices      | Implementing service browsing or search           |
 | `clients/` | Client-facing feature slices               | Implementing client dashboard or order views      |

```


### Milestone 2: processPaymentCapture integration tests

**Files**: src/features/payments/webhooks/__tests__/handlers.test.ts, src/features/payments/webhooks/__tests__/handlers-rollback.test.ts

**Acceptance Criteria**:

- npx vitest --run handlers.test.ts passes 3 tests (wallet creation, balance increment, idempotency)
- npx vitest --run handlers-rollback.test.ts passes 1 test (rollback error propagation)
- Test 1 asserts LabWallet.pendingBalance equals Transaction.amount using toFixed(2) comparison
- Test 2 asserts pendingBalance incremented from 500.00 to 2000.00 after 1500.00 payment
- Test 3 seeds Transaction with status=CAPTURED, asserts no LabWallet row created after processPaymentCapture
- Test 4 asserts processPaymentCapture rejects when tx.labWallet.upsert throws, confirming error propagation
- beforeEach in handlers.test.ts cleans up test data in FK-dependency order before each test

#### Code Intent

- **CI-M-002-001** `src/features/payments/webhooks/__tests__/handlers.test.ts`: Integration test file for processPaymentCapture tests 1-3 (real DB). Creates a separate PrismaClient connecting to DATABASE_TEST_URL for seed data operations and assertions. Uses vi.mock('@/lib/prisma') to replace the module-level prisma import with this test client instance, so processPaymentCapture uses the test DB. beforeEach cleanup deletes test data in FK-dependency order: LabWallet, Transaction, Order, ClientProfile, LabService, Lab, User — filtered by test-specific IDs. Each test seeds its own prerequisite data (User with role CLIENT, User with role LAB_ADMIN, Lab, LabService, ClientProfile, Order in PAYMENT_PENDING status, Transaction in PENDING status with a Decimal amount). Test 1 (first payment creates wallet): calls processPaymentCapture with valid XenditInvoicePayload (id matching Transaction.externalId), asserts LabWallet created for the lab with pendingBalance equal to Transaction.amount using toFixed(2) string comparison. Test 2 (subsequent payment increments balance): seeds existing LabWallet with pendingBalance 500.00, creates a second Order+Transaction for 1500.00, processes the second payment, asserts pendingBalance is 2000.00 via toFixed(2). Test 3 (idempotency guard): seeds Transaction with status CAPTURED (not PENDING) and Order with status ACKNOWLEDGED, calls processPaymentCapture, asserts no LabWallet row exists (function returned early at idempotency guard before wallet upsert). afterAll disconnects the test PrismaClient. (refs: DL-002, DL-003, DL-004, DL-005, DL-006)
- **CI-M-002-002** `src/features/payments/webhooks/__tests__/handlers-rollback.test.ts`: Unit test file for processPaymentCapture test 4 (rollback via full Prisma mock). Uses vi.mock('@/lib/prisma') with a factory that returns a fully mocked prisma object. Also uses vi.mock for '@/features/orders/handle-payment-captured/handler' to stub handlePaymentCaptured (it would fail without a real DB). The mock prisma.$transaction is implemented as a function that receives the callback and calls it with a mock tx client object. The mock tx client stubs ALL operations used inside processPaymentCapture's $transaction callback: tx.transaction.findFirst (returns a mock Transaction object with id, externalId, orderId, amount as Decimal, status PENDING), tx.transaction.update (resolves), tx.order.findUnique (returns {labId: 'mock-lab-id'}), tx.labWallet.upsert (rejects with new Error('wallet failure')). The mocked handlePaymentCaptured resolves successfully. Test asserts: processPaymentCapture rejects with the 'wallet failure' error (error propagates out of $transaction). Since $transaction is mocked (not real Prisma), there is no actual rollback to verify — the test confirms error propagation, which is the precondition for Prisma's real $transaction to roll back. (refs: DL-002, DL-006)

#### Code Changes

**CC-M-002-001** (src/features/payments/webhooks/__tests__/handlers.test.ts) - implements CI-M-002-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/webhooks/__tests__/handlers.test.ts
@@ -0,0 +1,162 @@
+import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
+import { PrismaClient, OrderStatus, TransactionStatus, UserRole, ServiceCategory, PricingMode } from '@prisma/client'
+import { processPaymentCapture } from '../handlers'
+import type { XenditInvoicePayload } from '../types'
+
+const testPrisma = new PrismaClient({
+  datasources: { db: { url: process.env.DATABASE_TEST_URL } },
+})
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: testPrisma,
+}))
+
+const TEST_USER_CLIENT_ID = 'test-user-client-1'
+const TEST_USER_LAB_ID = 'test-user-lab-1'
+const TEST_LAB_ID = 'test-lab-1'
+const TEST_SERVICE_ID = 'test-service-1'
+const TEST_ORDER_ID_1 = 'test-order-1'
+const TEST_ORDER_ID_2 = 'test-order-2'
+const TEST_TX_EXTERNAL_ID_1 = 'xendit-test-ext-1'
+const TEST_TX_EXTERNAL_ID_2 = 'xendit-test-ext-2'
+const TEST_TX_EXTERNAL_ID_3 = 'xendit-test-ext-3'
+
+async function cleanup() {
+  await testPrisma.labWallet.deleteMany({ where: { labId: TEST_LAB_ID } })
+  await testPrisma.transaction.deleteMany({
+    where: {
+      externalId: {
+        in: [TEST_TX_EXTERNAL_ID_1, TEST_TX_EXTERNAL_ID_2, TEST_TX_EXTERNAL_ID_3],
+      },
+    },
+  })
+  await testPrisma.order.deleteMany({
+    where: { id: { in: [TEST_ORDER_ID_1, TEST_ORDER_ID_2] } },
+  })
+  await testPrisma.labService.deleteMany({ where: { id: TEST_SERVICE_ID } })
+  await testPrisma.lab.deleteMany({ where: { id: TEST_LAB_ID } })
+  await testPrisma.user.deleteMany({
+    where: { id: { in: [TEST_USER_CLIENT_ID, TEST_USER_LAB_ID] } },
+  })
+}
+
+async function seedBase() {
+  await testPrisma.user.createMany({
+    data: [
+      { id: TEST_USER_CLIENT_ID, email: 'client@test.local', role: UserRole.CLIENT },
+      { id: TEST_USER_LAB_ID, email: 'lab@test.local', role: UserRole.LAB_ADMIN },
+    ],
+    skipDuplicates: true,
+  })
+  await testPrisma.lab.upsert({
+    where: { id: TEST_LAB_ID },
+    update: {},
+    create: { id: TEST_LAB_ID, ownerId: TEST_USER_LAB_ID, name: 'Test Lab' },
+  })
+  await testPrisma.labService.upsert({
+    where: { id: TEST_SERVICE_ID },
+    update: {},
+    create: {
+      id: TEST_SERVICE_ID,
+      labId: TEST_LAB_ID,
+      name: 'Test Service',
+      category: ServiceCategory.CHEMICAL_TESTING,
+      pricingMode: PricingMode.FIXED,
+    },
+  })
+}
+
+beforeEach(async () => {
+  await cleanup()
+  await seedBase()
+})
+
+afterAll(async () => {
+  await cleanup()
+  await testPrisma.$disconnect()
+})
+
+describe('processPaymentCapture', () => {
+  it('creates LabWallet with pendingBalance equal to Transaction.amount on first payment', async () => {
+    await testPrisma.order.create({
+      data: {
+        id: TEST_ORDER_ID_1,
+        clientId: TEST_USER_CLIENT_ID,
+        labId: TEST_LAB_ID,
+        serviceId: TEST_SERVICE_ID,
+        status: OrderStatus.PAYMENT_PENDING,
+        quantity: 1,
+      },
+    })
+    await testPrisma.transaction.create({
+      data: {
+        id: 'test-tx-1',
+        orderId: TEST_ORDER_ID_1,
+        externalId: TEST_TX_EXTERNAL_ID_1,
+        provider: 'xendit',
+        amount: '1500.00',
+        status: TransactionStatus.PENDING,
+      },
+    })
+
+    const payload: XenditInvoicePayload = {
+      id: TEST_TX_EXTERNAL_ID_1,
+      status: 'PAID',
+      paid_amount: 1500,
+      payer_email: 'client@test.local',
+      payment_method: 'CREDIT_CARD',
+    }
+
+    await processPaymentCapture(payload)
+
+    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
+    expect(wallet).not.toBeNull()
+    expect(wallet!.pendingBalance.toFixed(2)).toBe('1500.00')
+  })
+
+  it('increments pendingBalance on subsequent payment', async () => {
+    await testPrisma.labWallet.create({
+      data: { labId: TEST_LAB_ID, pendingBalance: '500.00' },
+    })
+    await testPrisma.order.create({
+      data: {
+        id: TEST_ORDER_ID_2,
+        clientId: TEST_USER_CLIENT_ID,
+        labId: TEST_LAB_ID,
+        serviceId: TEST_SERVICE_ID,
+        status: OrderStatus.PAYMENT_PENDING,
+        quantity: 1,
+      },
+    })
+    await testPrisma.transaction.create({
+      data: {
+        id: 'test-tx-2',
+        orderId: TEST_ORDER_ID_2,
+        externalId: TEST_TX_EXTERNAL_ID_2,
+        provider: 'xendit',
+        amount: '1500.00',
+        status: TransactionStatus.PENDING,
+      },
+    })
+
+    const payload: XenditInvoicePayload = {
+      id: TEST_TX_EXTERNAL_ID_2,
+      status: 'PAID',
+      paid_amount: 1500,
+      payer_email: 'client@test.local',
+    }
+
+    await processPaymentCapture(payload)
+
+    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
+    expect(wallet!.pendingBalance.toFixed(2)).toBe('2000.00')
+  })
+
+  it('returns early without crediting LabWallet when Transaction is already CAPTURED (idempotency)', async () => {
+    await testPrisma.order.create({
+      data: {
+        id: TEST_ORDER_ID_1,
+        clientId: TEST_USER_CLIENT_ID,
+        labId: TEST_LAB_ID,
+        serviceId: TEST_SERVICE_ID,
+        status: OrderStatus.ACKNOWLEDGED,
+        quantity: 1,
+      },
+    })
+    await testPrisma.transaction.create({
+      data: {
+        id: 'test-tx-3',
+        orderId: TEST_ORDER_ID_1,
+        externalId: TEST_TX_EXTERNAL_ID_3,
+        provider: 'xendit',
+        amount: '1500.00',
+        status: TransactionStatus.CAPTURED,
+      },
+    })
+
+    const payload: XenditInvoicePayload = {
+      id: TEST_TX_EXTERNAL_ID_3,
+      status: 'PAID',
+      paid_amount: 1500,
+      payer_email: 'client@test.local',
+    }
+
+    await processPaymentCapture(payload)
+
+    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
+    expect(wallet).toBeNull()
+  })
+})
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/payments/webhooks/__tests__/handlers.test.ts
@@ -0,0 +1,175 @@
+// Integration tests for processPaymentCapture against a real test database.
+// Tests 1-3 verify financial ledger correctness (wallet creation, balance increment, idempotency)
+// using real Prisma + PostgreSQL — mocking would hide Decimal type mismatches and FK constraint bugs. (ref: DL-002)
+// Test 4 (rollback) lives in handlers-rollback.test.ts with a full Prisma mock because vi.mock is
+// module-scoped; a single file cannot serve both a real PrismaClient and a full mock. (ref: DL-006)
+import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
+import { PrismaClient, OrderStatus, TransactionStatus, UserRole, ServiceCategory, PricingMode } from '@prisma/client'
+import { processPaymentCapture } from '../handlers'
+import type { XenditInvoicePayload } from '../types'
+
+// Inline PrismaClient pointing at DATABASE_TEST_URL — not extracted to shared test-utils because
+// this is the only test file that needs it (YAGNI). Extract when a second file appears. (ref: DL-003)
+const testPrisma = new PrismaClient({
+  datasources: { db: { url: process.env.DATABASE_TEST_URL } },
+})
+
+// Replaces the @/lib/prisma singleton that processPaymentCapture imports, injecting testPrisma
+// so all DB writes go to the test database without modifying source code. (ref: DL-004)
+vi.mock('@/lib/prisma', () => ({
+  prisma: testPrisma,
+}))
+
+// Stable IDs used across seed and cleanup — must be unique per test suite to avoid conflicts
+// if multiple test files run against the same test database.
+const TEST_USER_CLIENT_ID = 'test-user-client-1'
+const TEST_USER_LAB_ID = 'test-user-lab-1'
+const TEST_LAB_ID = 'test-lab-1'
+const TEST_SERVICE_ID = 'test-service-1'
+const TEST_ORDER_ID_1 = 'test-order-1'
+const TEST_ORDER_ID_2 = 'test-order-2'
+const TEST_TX_EXTERNAL_ID_1 = 'xendit-test-ext-1'
+const TEST_TX_EXTERNAL_ID_2 = 'xendit-test-ext-2'
+const TEST_TX_EXTERNAL_ID_3 = 'xendit-test-ext-3'
+
+// Deletes all test-owned rows in FK-dependency order: child tables first, then parent tables.
+// LabWallet → Transaction → Order → LabService → Lab → User. (ref: R-002)
+async function cleanup() {
+  await testPrisma.labWallet.deleteMany({ where: { labId: TEST_LAB_ID } })
+  await testPrisma.transaction.deleteMany({
+    where: { externalId: { in: [TEST_TX_EXTERNAL_ID_1, TEST_TX_EXTERNAL_ID_2, TEST_TX_EXTERNAL_ID_3] } },
+  })
+  await testPrisma.order.deleteMany({ where: { id: { in: [TEST_ORDER_ID_1, TEST_ORDER_ID_2] } } })
+  await testPrisma.labService.deleteMany({ where: { id: TEST_SERVICE_ID } })
+  await testPrisma.lab.deleteMany({ where: { id: TEST_LAB_ID } })
+  await testPrisma.user.deleteMany({ where: { id: { in: [TEST_USER_CLIENT_ID, TEST_USER_LAB_ID] } } })
+}
+
+// Creates the minimum graph required by Order FK constraints:
+// User (CLIENT), User (LAB_ADMIN) → Lab (ownerId) → LabService.
+async function seedBase() {
+  await testPrisma.user.createMany({
+    data: [
+      { id: TEST_USER_CLIENT_ID, email: 'client@test.local', role: UserRole.CLIENT },
+      { id: TEST_USER_LAB_ID, email: 'lab@test.local', role: UserRole.LAB_ADMIN },
+    ],
+    skipDuplicates: true,
+  })
+  await testPrisma.lab.upsert({
+    where: { id: TEST_LAB_ID },
+    update: {},
+    create: { id: TEST_LAB_ID, ownerId: TEST_USER_LAB_ID, name: 'Test Lab' },
+  })
+  await testPrisma.labService.upsert({
+    where: { id: TEST_SERVICE_ID },
+    update: {},
+    create: {
+      id: TEST_SERVICE_ID,
+      labId: TEST_LAB_ID,
+      name: 'Test Service',
+      category: ServiceCategory.CHEMICAL_TESTING,
+      pricingMode: PricingMode.FIXED,
+    },
+  })
+}
+
+// Reset and re-seed before each test to guarantee isolation — leftover data from prior tests
+// or interrupted runs cannot affect assertions. (ref: R-002)
+beforeEach(async () => {
+  await cleanup()
+  await seedBase()
+})
+
+afterAll(async () => {
+  await cleanup()
+  await testPrisma.$disconnect()
+})
+
+describe('processPaymentCapture', () => {
+  // Test 1: first payment — no existing LabWallet row.
+  // Verifies processPaymentCapture creates LabWallet via upsert with pendingBalance set to
+  // Transaction.amount. Asserts using .toFixed(2) to avoid Decimal === number comparison failure. (ref: DL-005)
+  it('creates LabWallet with pendingBalance equal to Transaction.amount on first payment', async () => {
+    await testPrisma.order.create({
+      data: {
+        id: TEST_ORDER_ID_1, clientId: TEST_USER_CLIENT_ID, labId: TEST_LAB_ID,
+        serviceId: TEST_SERVICE_ID, status: OrderStatus.PAYMENT_PENDING, quantity: 1,
+      },
+    })
+    await testPrisma.transaction.create({
+      data: {
+        id: 'test-tx-1', orderId: TEST_ORDER_ID_1, externalId: TEST_TX_EXTERNAL_ID_1,
+        provider: 'xendit', amount: '1500.00', status: TransactionStatus.PENDING,
+      },
+    })
+    const payload: XenditInvoicePayload = {
+      id: TEST_TX_EXTERNAL_ID_1, status: 'PAID', paid_amount: 1500, payer_email: 'client@test.local',
+    }
+    await processPaymentCapture(payload)
+    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
+    expect(wallet).not.toBeNull()
+    // pendingBalance is Prisma Decimal — .toFixed(2) converts to string for reliable comparison. (ref: DL-005)
+    expect(wallet!.pendingBalance.toFixed(2)).toBe('1500.00')
+  })
+
+  // Test 2: subsequent payment — existing LabWallet with pendingBalance 500.00.
+  // Verifies upsert increment: 500.00 + 1500.00 = 2000.00.
+  // Seeds a LabWallet before processing, then checks the incremented balance.
+  it('increments pendingBalance on subsequent payment', async () => {
+    await testPrisma.labWallet.create({ data: { labId: TEST_LAB_ID, pendingBalance: '500.00' } })
+    await testPrisma.order.create({
+      data: {
+        id: TEST_ORDER_ID_2, clientId: TEST_USER_CLIENT_ID, labId: TEST_LAB_ID,
+        serviceId: TEST_SERVICE_ID, status: OrderStatus.PAYMENT_PENDING, quantity: 1,
+      },
+    })
+    await testPrisma.transaction.create({
+      data: {
+        id: 'test-tx-2', orderId: TEST_ORDER_ID_2, externalId: TEST_TX_EXTERNAL_ID_2,
+        provider: 'xendit', amount: '1500.00', status: TransactionStatus.PENDING,
+      },
+    })
+    const payload: XenditInvoicePayload = {
+      id: TEST_TX_EXTERNAL_ID_2, status: 'PAID', paid_amount: 1500, payer_email: 'client@test.local',
+    }
+    await processPaymentCapture(payload)
+    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
+    expect(wallet!.pendingBalance.toFixed(2)).toBe('2000.00')
+  })
+
+  // Test 3: idempotency guard — Transaction already CAPTURED.
+  // The guard in processPaymentCapture checks Transaction.status === CAPTURED (not Order.status).
+  // Test seeds Transaction with status=CAPTURED so the function returns early before any wallet write.
+  // Asserts no LabWallet row exists, confirming the early return fired before labWallet.upsert. (ref: DL-002)
+  it('returns early without crediting LabWallet when Transaction is already CAPTURED (idempotency)', async () => {
+    await testPrisma.order.create({
+      data: {
+        id: TEST_ORDER_ID_1, clientId: TEST_USER_CLIENT_ID, labId: TEST_LAB_ID,
+        serviceId: TEST_SERVICE_ID, status: OrderStatus.ACKNOWLEDGED, quantity: 1,
+      },
+    })
+    await testPrisma.transaction.create({
+      data: {
+        id: 'test-tx-3', orderId: TEST_ORDER_ID_1, externalId: TEST_TX_EXTERNAL_ID_3,
+        provider: 'xendit', amount: '1500.00', status: TransactionStatus.CAPTURED,
+      },
+    })
+    const payload: XenditInvoicePayload = {
+      id: TEST_TX_EXTERNAL_ID_3, status: 'PAID', paid_amount: 1500, payer_email: 'client@test.local',
+    }
+    await processPaymentCapture(payload)
+    // No LabWallet row should exist — the function returned before reaching labWallet.upsert.
+    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
+    expect(wallet).toBeNull()
+  })
+})

```


**CC-M-002-002** (src/features/payments/webhooks/__tests__/handlers-rollback.test.ts) - implements CI-M-002-002

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/webhooks/__tests__/handlers-rollback.test.ts
@@ -0,0 +1,70 @@
+import { describe, it, expect, vi } from 'vitest'
+import { Decimal } from '@prisma/client/runtime/library'
+import { TransactionStatus } from '@prisma/client'
+
+const mockTxUpdate = vi.fn().mockResolvedValue({})
+const mockTxOrderFindUnique = vi.fn().mockResolvedValue({ labId: 'mock-lab-id' })
+const mockTxLabWalletUpsert = vi.fn().mockRejectedValue(new Error('wallet failure'))
+const mockTxTransactionFindFirst = vi.fn().mockResolvedValue({
+  id: 'mock-tx-id',
+  externalId: 'xendit-mock-ext',
+  orderId: 'mock-order-id',
+  amount: new Decimal('750.00'),
+  status: TransactionStatus.PENDING,
+})
+
+const mockTx = {
+  transaction: {
+    findFirst: mockTxTransactionFindFirst,
+    update: mockTxUpdate,
+  },
+  order: {
+    findUnique: mockTxOrderFindUnique,
+  },
+  labWallet: {
+    upsert: mockTxLabWalletUpsert,
+  },
+}
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    $transaction: vi.fn((callback: (tx: typeof mockTx) => Promise<void>) => callback(mockTx)),
+  },
+}))
+
+vi.mock('@/features/orders/handle-payment-captured/handler', () => ({
+  handlePaymentCaptured: vi.fn().mockResolvedValue(undefined),
+}))
+
+import { processPaymentCapture } from '../handlers'
+import type { XenditInvoicePayload } from '../types'
+
+describe('processPaymentCapture — rollback error propagation', () => {
+  it('rejects with the wallet upsert error, confirming error propagation that triggers Prisma rollback', async () => {
+    const payload: XenditInvoicePayload = {
+      id: 'xendit-mock-ext',
+      status: 'PAID',
+      paid_amount: 750,
+      payer_email: 'lab@test.local',
+    }
+
+    await expect(processPaymentCapture(payload)).rejects.toThrow('wallet failure')
+  })
+})
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/__tests__/handlers-rollback.test.ts
+++ b/src/features/payments/webhooks/__tests__/handlers-rollback.test.ts
@@ -0,0 +1,75 @@
+// Rollback error propagation test for processPaymentCapture.
+// Uses a full Prisma mock (vi.fn() stubs) because forcing tx.labWallet.upsert to fail on a real
+// database is not possible without schema changes. This test verifies that a wallet upsert failure
+// propagates out of the $transaction callback — Prisma/PostgreSQL guarantee the atomic rollback. (ref: DL-002)
+//
+// Kept in a separate file from handlers.test.ts because vi.mock is hoisted and module-scoped:
+// a single file cannot use both a real PrismaClient (tests 1-3) and a full mock (test 4)
+// without fragile vi.resetModules or conditional factory logic. (ref: DL-006)
+import { describe, it, expect, vi } from 'vitest'
+import { Decimal } from '@prisma/client/runtime/library'
+import { TransactionStatus } from '@prisma/client'
+
+// vi.fn() stubs for the interactive transaction client (tx.*).
+// mockTxLabWalletUpsert rejects to simulate a wallet write failure — this is the error that
+// must propagate out of $transaction to trigger Prisma's automatic rollback. (ref: DL-002, R-003)
+const mockTxUpdate = vi.fn().mockResolvedValue({})
+const mockTxOrderFindUnique = vi.fn().mockResolvedValue({ labId: 'mock-lab-id' })
+const mockTxLabWalletUpsert = vi.fn().mockRejectedValue(new Error('wallet failure'))
+const mockTxTransactionFindFirst = vi.fn().mockResolvedValue({
+  id: 'mock-tx-id',
+  externalId: 'xendit-mock-ext',
+  orderId: 'mock-order-id',
+  amount: new Decimal('750.00'), // Decimal type matches the real schema; avoids === comparison issues (ref: DL-005)
+  status: TransactionStatus.PENDING,
+})
+
+// Assembles the interactive transaction client shape expected by processPaymentCapture.
+// Mirrors the tx.* calls inside the $transaction callback in handlers.ts.
+const mockTx = {
+  transaction: {
+    findFirst: mockTxTransactionFindFirst,
+    update: mockTxUpdate,
+  },
+  order: {
+    findUnique: mockTxOrderFindUnique,
+  },
+  labWallet: {
+    upsert: mockTxLabWalletUpsert,
+  },
+}
+
+// Full mock of @/lib/prisma — replaces the singleton with a mock whose $transaction
+// immediately invokes the callback with mockTx, letting the test control every tx.* call.
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    $transaction: vi.fn((callback: (tx: typeof mockTx) => Promise<void>) => callback(mockTx)),
+  },
+}))
+
+// Mock handlePaymentCaptured so this file only tests the wallet upsert failure path —
+// handlePaymentCaptured is tested separately in the orders slice.
+vi.mock('@/features/orders/handle-payment-captured/handler', () => ({
+  handlePaymentCaptured: vi.fn().mockResolvedValue(undefined),
+}))
+
+import { processPaymentCapture } from '../handlers'
+import type { XenditInvoicePayload } from '../types'
+
+describe('processPaymentCapture — rollback error propagation', () => {
+  it('rejects with the wallet upsert error, confirming error propagation that triggers Prisma rollback', async () => {
+    const payload: XenditInvoicePayload = {
+      id: 'xendit-mock-ext',
+      status: 'PAID',
+      paid_amount: 750,
+      payer_email: 'lab@test.local',
+    }
+
+    await expect(processPaymentCapture(payload)).rejects.toThrow('wallet failure')
+  })
+})

```


**CC-M-002-003** (src/features/payments/webhooks/README.md)

**Documentation:**

```diff
--- a/src/features/payments/webhooks/README.md
+++ b/src/features/payments/webhooks/README.md
@@ -82,3 +82,22 @@
 Missing `XENDIT_WEBHOOK_TOKEN` returns 500 (not 401) to surface misconfiguration
 in error monitoring before any token comparison.
+
+## Test strategy
+
+Integration tests for `processPaymentCapture` are split across two files by mocking strategy:
+
+| File | Tests | DB strategy | Why |
+|------|-------|-------------|-----|
+| `__tests__/handlers.test.ts` | 1-3: wallet creation, balance increment, idempotency | Real test database (`DATABASE_TEST_URL`) | Financial ledger correctness requires DB-level verification — mocking hides Decimal type mismatches and FK constraint errors |
+| `__tests__/handlers-rollback.test.ts` | 4: rollback error propagation | Full Prisma mock (`vi.fn()` stubs) | Forcing `tx.labWallet.upsert` to fail on a real database requires schema changes; `$transaction` atomicity is a Prisma/PostgreSQL guarantee, so this test verifies error propagation only |
+
+Tests 1-3 require `DATABASE_TEST_URL` set in `.env.test`. The global setup
+(`src/test/global-setup.ts`) runs `prisma db push` against the test database
+before any tests execute. (ref: DL-002, DL-006, DL-007)
+
+### Why the split matters
+
+A test added to `handlers.test.ts` that mocks Prisma would silently defeat the
+purpose of the real-DB tests — mocked Decimal arithmetic does not catch
+`toFixed()` regressions or FK constraint violations. Keep tests 1-3 on the real
+DB; add new mock-based tests to `handlers-rollback.test.ts`.

```

