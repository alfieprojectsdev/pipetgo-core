### 1. The Payment Enums

These define the strict state machines for money movement. Place these near the top of your `schema.prisma`.

```prisma
enum TransactionStatus {
  PENDING    // Payment intent created, awaiting client action
  PROCESSING // Client initiated payment, awaiting aggregator confirmation
  CAPTURED   // Payment successfully captured by PayMongo/Xendit
  FAILED     // Payment attempt failed
  REFUNDED   // Full or partial refund completed
}

enum PayoutStatus {
  QUEUED     // Payout calculated, awaiting batch processing
  PROCESSING // Batch submitted to aggregator disbursement API
  COMPLETED  // Funds transferred to lab's bank account
  FAILED     // Disbursement failed (requires manual resolution)
}

```

### 2. The Core Transaction Model

This model tracks the lifecycle of the client paying the platform. The `externalId` is critical—it maps directly to the PayMongo/Xendit ID and acts as the idempotency key for your webhooks.

```prisma
model Transaction {
  id                String            @id @default(cuid())
  orderId           String
  externalId        String            @unique  // e.g., pi_12345 from PayMongo
  provider          String            // "paymongo" | "xendit"
  amount            Decimal           @db.Decimal(12, 2)
  currency          String            @default("PHP")
  status            TransactionStatus @default(PENDING)
  
  // Captures if they used 'pesonet', 'gcash', 'qrph', or 'card'
  paymentMethod     String?           
  checkoutUrl       String?           // Where to redirect the client to pay
  failureReason     String?
  metadata          Json?             // Stores the raw webhook payload for auditing
  
  capturedAt        DateTime?
  refundedAt        DateTime?
  createdAt         DateTime          @default(now())
  updatedAt         DateTime          @updatedAt

  order   Order    @relation(fields: [orderId], references: [id])
  payouts Payout[] // A transaction can generate one or more payouts (platform vs lab cut)

  // Indexes optimized for webhook lookups and dashboard sorting
  @@index([orderId, status])
  @@index([externalId])
  @@index([status, createdAt(sort: Desc)])
  @@map("transactions")
}

```

### 3. Option A Readiness: Payouts & Wallets

If Elena decides on **Option A (Marketplace Split)**, you need these models to track the lab's cut versus PipetGo!'s commission. Even if you start with Option B, having this in the schema design ensures you don't have to rip up the database later.

```prisma
model Payout {
  id                String       @id @default(cuid())
  labId             String
  orderId           String
  transactionId     String
  
  grossAmount       Decimal      @db.Decimal(12, 2)  // Total client payment
  platformFee       Decimal      @db.Decimal(12, 2)  // PipetGo! commission deducted
  netAmount         Decimal      @db.Decimal(12, 2)  // Amount owed to the lab
  feePercentage     Decimal      @db.Decimal(5, 4)   // Snapshot of the rate (e.g., 0.0500 for 5%)
  
  status            PayoutStatus @default(QUEUED)
  externalPayoutId  String?      @unique             // Aggregator disbursement ID
  scheduledDate     DateTime?    // Next batch run date
  completedAt       DateTime?
  failureReason     String?
  
  createdAt         DateTime     @default(now())
  updatedAt         DateTime     @updatedAt

  lab         Lab         @relation(fields: [labId], references: [id])
  order       Order       @relation(fields: [orderId], references: [id])
  transaction Transaction @relation(fields: [transactionId], references: [id])

  @@index([labId, status])
  @@index([orderId])
  @@index([status, scheduledDate])
  @@map("payouts")
}

model LabWallet {
  id               String   @id @default(cuid())
  labId            String   @unique  
  
  // Strict separation of what is processing vs what can be withdrawn
  pendingBalance   Decimal  @db.Decimal(12, 2) @default(0)   
  availableBalance Decimal  @db.Decimal(12, 2) @default(0)   
  withdrawnTotal   Decimal  @db.Decimal(12, 2) @default(0)   
  
  currency         String   @default("PHP")
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  lab Lab @relation(fields: [labId], references: [id])

  @@map("lab_wallets")
}

```

### 4. Hooking it into the V1 Models

To tie this all together, you just need to add the relation arrays and a few denormalized caching fields to your existing `Order` and `Lab` models.

```prisma
// 1. Add to your existing Order model:
model Order {
  // ... your existing V1 fields ...
  
  // New V2 Payment Status Enum fields
  status            OrderStatus // Make sure PAYMENT_PENDING is in this enum now
  
  // Denormalized fields for lightning-fast UI rendering without JOINs
  paymentIntentId   String?     
  paidAt            DateTime?   
  paymentMethod     String?     
  refundedAt        DateTime?   

  // Relations
  transactions      Transaction[]
  payouts           Payout[]
}

// 2. Add to your existing Lab model:
model Lab {
  // ... your existing V1 fields ...

  // Relations
  wallet            LabWallet?
  payouts           Payout[]
}

```