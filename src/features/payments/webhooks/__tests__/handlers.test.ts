import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { OrderStatus, TransactionStatus, UserRole, ServiceCategory, PricingMode, PayoutStatus } from '@prisma/client'
import { testPrisma } from '@/test/test-prisma'
import { processPaymentCapture, processPaymentFailed } from '../handlers'
import { completeOrder } from '@/features/orders/lab-fulfillment/action'
import type { NormalizedWebhookPayload } from '@/lib/payments/types'

vi.mock('@/lib/prisma', async () => {
  const { testPrisma: client } = await import('@/test/test-prisma')
  return { prisma: client }
})

vi.mock('@/lib/auth', () => ({
  auth: vi.fn().mockResolvedValue({
    user: { id: 'test-user-lab-1', role: 'LAB_ADMIN' },
  }),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

const TEST_USER_CLIENT_ID = 'test-user-client-1'
const TEST_USER_LAB_ID = 'test-user-lab-1'
const TEST_LAB_ID = 'test-lab-1'
const TEST_SERVICE_ID = 'test-service-1'
const TEST_ORDER_ID_1 = 'test-order-1'
const TEST_ORDER_ID_2 = 'test-order-2'
const TEST_TX_EXTERNAL_ID_1 = 'xendit-test-ext-1'
const TEST_TX_EXTERNAL_ID_2 = 'xendit-test-ext-2'
const TEST_TX_EXTERNAL_ID_3 = 'xendit-test-ext-3'
const TEST_TX_EXTERNAL_ID_4 = 'xendit-test-ext-4'
const TEST_TX_EXTERNAL_ID_5 = 'xendit-test-ext-5'
const TEST_TX_EXTERNAL_ID_6 = 'xendit-test-ext-6'
const TEST_ORDER_ID_3 = 'test-order-3'
const TEST_ORDER_ID_4 = 'test-order-4'

async function cleanup() {
  await testPrisma.idempotencyKey.deleteMany({
    where: {
      key: {
        in: [
          `xendit:invoice:PAID:${TEST_TX_EXTERNAL_ID_1}`,
          `xendit:invoice:PAID:${TEST_TX_EXTERNAL_ID_2}`,
          `xendit:invoice:EXPIRED:${TEST_TX_EXTERNAL_ID_4}`,
          `xendit:invoice:PAID:${TEST_TX_EXTERNAL_ID_5}`,
          `xendit:invoice:EXPIRED:${TEST_TX_EXTERNAL_ID_5}`,
          `xendit:invoice:PAID:${TEST_TX_EXTERNAL_ID_6}`,
          `xendit:invoice:EXPIRED:${TEST_TX_EXTERNAL_ID_6}`,
        ],
      },
    },
  })
  await testPrisma.payout.deleteMany({
    where: { orderId: { in: [TEST_ORDER_ID_1, TEST_ORDER_ID_2, TEST_ORDER_ID_3, TEST_ORDER_ID_4] } },
  })
  await testPrisma.labWallet.deleteMany({ where: { labId: TEST_LAB_ID } })
  await testPrisma.transaction.deleteMany({
    where: {
      externalId: {
        in: [
          TEST_TX_EXTERNAL_ID_1,
          TEST_TX_EXTERNAL_ID_2,
          TEST_TX_EXTERNAL_ID_3,
          TEST_TX_EXTERNAL_ID_4,
          TEST_TX_EXTERNAL_ID_5,
          TEST_TX_EXTERNAL_ID_6,
        ],
      },
    },
  })
  await testPrisma.order.deleteMany({
    where: { id: { in: [TEST_ORDER_ID_1, TEST_ORDER_ID_2, TEST_ORDER_ID_3, TEST_ORDER_ID_4] } },
  })
  await testPrisma.labService.deleteMany({ where: { id: TEST_SERVICE_ID } })
  await testPrisma.lab.deleteMany({ where: { id: TEST_LAB_ID } })
  await testPrisma.user.deleteMany({
    where: { id: { in: [TEST_USER_CLIENT_ID, TEST_USER_LAB_ID] } },
  })
}

async function seedBase() {
  await testPrisma.user.createMany({
    data: [
      { id: TEST_USER_CLIENT_ID, email: 'client@test.local', role: UserRole.CLIENT },
      { id: TEST_USER_LAB_ID, email: 'lab@test.local', role: UserRole.LAB_ADMIN },
    ],
    skipDuplicates: true,
  })
  await testPrisma.lab.upsert({
    where: { id: TEST_LAB_ID },
    update: {},
    create: { id: TEST_LAB_ID, ownerId: TEST_USER_LAB_ID, name: 'Test Lab' },
  })
  await testPrisma.labService.upsert({
    where: { id: TEST_SERVICE_ID },
    update: {},
    create: {
      id: TEST_SERVICE_ID,
      labId: TEST_LAB_ID,
      name: 'Test Service',
      category: ServiceCategory.CHEMICAL_TESTING,
      pricingMode: PricingMode.FIXED,
    },
  })
}

beforeEach(async () => {
  await cleanup()
  await seedBase()
})

afterAll(async () => {
  await cleanup()
  await testPrisma.$disconnect()
})

describe('processPaymentCapture', () => {
  // Under AD-001 Direct Payment, processPaymentCapture must NOT write LabWallet. (ref: DL-001, DL-008)
  it('advances Transaction to CAPTURED and does not credit LabWallet on first payment under AD-001', async () => {
    await testPrisma.order.create({
      data: {
        id: TEST_ORDER_ID_1,
        clientId: TEST_USER_CLIENT_ID,
        labId: TEST_LAB_ID,
        serviceId: TEST_SERVICE_ID,
        status: OrderStatus.PAYMENT_PENDING,
        quantity: 1,
      },
    })
    await testPrisma.transaction.create({
      data: {
        id: 'test-tx-1',
        orderId: TEST_ORDER_ID_1,
        externalId: TEST_TX_EXTERNAL_ID_1,
        provider: 'xendit',
        amount: '1500.00',
        status: TransactionStatus.PENDING,
      },
    })

    const payload: NormalizedWebhookPayload = {
      externalId: TEST_TX_EXTERNAL_ID_1,
      paymentMethod: 'CREDIT_CARD',
    }

    await processPaymentCapture(payload)

    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
    expect(wallet).toBeNull()
    const tx = await testPrisma.transaction.findUnique({ where: { externalId: TEST_TX_EXTERNAL_ID_1 } })
    expect(tx!.status).toBe(TransactionStatus.CAPTURED)
  })

  it('leaves pre-existing LabWallet row balance unchanged under AD-001', async () => {
    await testPrisma.labWallet.create({
      data: { labId: TEST_LAB_ID, pendingBalance: '500.00' },
    })
    await testPrisma.order.create({
      data: {
        id: TEST_ORDER_ID_2,
        clientId: TEST_USER_CLIENT_ID,
        labId: TEST_LAB_ID,
        serviceId: TEST_SERVICE_ID,
        status: OrderStatus.PAYMENT_PENDING,
        quantity: 1,
      },
    })
    await testPrisma.transaction.create({
      data: {
        id: 'test-tx-2',
        orderId: TEST_ORDER_ID_2,
        externalId: TEST_TX_EXTERNAL_ID_2,
        provider: 'xendit',
        amount: '1500.00',
        status: TransactionStatus.PENDING,
      },
    })

    const payload: NormalizedWebhookPayload = {
      externalId: TEST_TX_EXTERNAL_ID_2,
    }

    await processPaymentCapture(payload)

    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
    expect(wallet!.pendingBalance.toFixed(2)).toBe('500.00')
  })

  it('returns early without crediting LabWallet when Transaction is already CAPTURED (idempotency)', async () => {
    await testPrisma.order.create({
      data: {
        id: TEST_ORDER_ID_1,
        clientId: TEST_USER_CLIENT_ID,
        labId: TEST_LAB_ID,
        serviceId: TEST_SERVICE_ID,
        status: OrderStatus.ACKNOWLEDGED,
        quantity: 1,
      },
    })
    await testPrisma.transaction.create({
      data: {
        id: 'test-tx-3',
        orderId: TEST_ORDER_ID_1,
        externalId: TEST_TX_EXTERNAL_ID_3,
        provider: 'xendit',
        amount: '1500.00',
        status: TransactionStatus.CAPTURED,
      },
    })

    const payload: NormalizedWebhookPayload = {
      externalId: TEST_TX_EXTERNAL_ID_3,
    }

    await processPaymentCapture(payload)

    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
    expect(wallet).toBeNull()
  })

  it('returns early on duplicate delivery when IdempotencyKey already exists for the PAID key', async () => {
    await testPrisma.order.create({
      data: {
        id: TEST_ORDER_ID_3,
        clientId: TEST_USER_CLIENT_ID,
        labId: TEST_LAB_ID,
        serviceId: TEST_SERVICE_ID,
        status: OrderStatus.PAYMENT_PENDING,
        quantity: 1,
      },
    })
    await testPrisma.transaction.create({
      data: {
        id: 'test-tx-idem-paid',
        orderId: TEST_ORDER_ID_3,
        externalId: TEST_TX_EXTERNAL_ID_5,
        provider: 'xendit',
        amount: '1500.00',
        status: TransactionStatus.PENDING,
      },
    })
    await testPrisma.idempotencyKey.create({
      data: { key: `xendit:invoice:PAID:${TEST_TX_EXTERNAL_ID_5}` },
    })

    const payload: NormalizedWebhookPayload = {
      externalId: TEST_TX_EXTERNAL_ID_5,
    }

    await processPaymentCapture(payload)

    const tx = await testPrisma.transaction.findUnique({ where: { externalId: TEST_TX_EXTERNAL_ID_5 } })
    expect(tx!.status).toBe(TransactionStatus.PENDING)
    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_3 } })
    expect(order!.status).toBe(OrderStatus.PAYMENT_PENDING)
    const keys = await testPrisma.idempotencyKey.findMany({
      where: { key: `xendit:invoice:PAID:${TEST_TX_EXTERNAL_ID_5}` },
    })
    expect(keys).toHaveLength(1)
  })

  it('creates IdempotencyKey row inside the same transaction as the business writes', async () => {
    await testPrisma.order.create({
      data: {
        id: TEST_ORDER_ID_4,
        clientId: TEST_USER_CLIENT_ID,
        labId: TEST_LAB_ID,
        serviceId: TEST_SERVICE_ID,
        status: OrderStatus.PAYMENT_PENDING,
        quantity: 1,
      },
    })
    await testPrisma.transaction.create({
      data: {
        id: 'test-tx-idem-create',
        orderId: TEST_ORDER_ID_4,
        externalId: TEST_TX_EXTERNAL_ID_6,
        provider: 'xendit',
        amount: '1500.00',
        status: TransactionStatus.PENDING,
      },
    })

    const payload: NormalizedWebhookPayload = {
      externalId: TEST_TX_EXTERNAL_ID_6,
    }

    await processPaymentCapture(payload)

    const tx = await testPrisma.transaction.findUnique({ where: { externalId: TEST_TX_EXTERNAL_ID_6 } })
    expect(tx!.status).toBe(TransactionStatus.CAPTURED)
    const key = await testPrisma.idempotencyKey.findUnique({
      where: { key: `xendit:invoice:PAID:${TEST_TX_EXTERNAL_ID_6}` },
    })
    expect(key).not.toBeNull()
  })

  // EXPIRED-then-PAID race guard (ref: R-007): PAID for a FAILED transaction throws.
  it('throws when Transaction is already FAILED (EXPIRED-then-PAID race, ref: R-007)', async () => {
    await testPrisma.order.create({
      data: {
        id: TEST_ORDER_ID_1,
        clientId: TEST_USER_CLIENT_ID,
        labId: TEST_LAB_ID,
        serviceId: TEST_SERVICE_ID,
        status: OrderStatus.PAYMENT_FAILED,
        quantity: 1,
      },
    })
    await testPrisma.transaction.create({
      data: {
        id: 'test-tx-failed-guard',
        orderId: TEST_ORDER_ID_1,
        externalId: TEST_TX_EXTERNAL_ID_4,
        provider: 'xendit',
        amount: '1500.00',
        status: TransactionStatus.FAILED,
        failureReason: 'Xendit invoice EXPIRED',
      },
    })

    const payload: NormalizedWebhookPayload = {
      externalId: TEST_TX_EXTERNAL_ID_4,
    }

    await expect(processPaymentCapture(payload)).rejects.toThrow(/FAILED/)
  })
})

// Payout creation tests live here (not lab-fulfillment/__tests__) to share the real-DB setup and cleanup with webhook capture tests. (ref: DL-003)
describe('completeOrder — Payout commission record creation', () => {
  const TEST_TX_INTERNAL_ID = 'test-tx-internal-payout'

  it('creates a QUEUED Payout with correct fee split when completeOrder is called on an IN_PROGRESS order', async () => {
    await testPrisma.order.create({
      data: {
        id: TEST_ORDER_ID_1,
        clientId: TEST_USER_CLIENT_ID,
        labId: TEST_LAB_ID,
        serviceId: TEST_SERVICE_ID,
        status: OrderStatus.IN_PROGRESS,
        quantity: 1,
      },
    })
    await testPrisma.transaction.create({
      data: {
        id: TEST_TX_INTERNAL_ID,
        orderId: TEST_ORDER_ID_1,
        externalId: TEST_TX_EXTERNAL_ID_1,
        provider: 'xendit',
        amount: '1500.00',
        status: TransactionStatus.CAPTURED,
      },
    })

    const formData = new FormData()
    formData.set('orderId', TEST_ORDER_ID_1)
    formData.set('notes', 'Done')

    await completeOrder(null, formData)

    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_1 } })
    expect(order!.status).toBe(OrderStatus.COMPLETED)
    expect(order!.notes).toBe('Done')

    const payouts = await testPrisma.payout.findMany({ where: { orderId: TEST_ORDER_ID_1 } })
    expect(payouts).toHaveLength(1)
    const payout = payouts[0]
    expect(payout.grossAmount.toFixed(2)).toBe('1500.00')
    expect(payout.platformFee.toFixed(2)).toBe('150.00')
    expect(payout.netAmount.toFixed(2)).toBe('1350.00')
    expect(payout.feePercentage.toFixed(4)).toBe('0.1000')
    expect(payout.status).toBe(PayoutStatus.QUEUED)
    expect(payout.transactionId).toBe(TEST_TX_INTERNAL_ID)
  })

  it('completes order without Payout when no CAPTURED Transaction exists (FIXED-mode)', async () => {
    await testPrisma.order.create({
      data: {
        id: TEST_ORDER_ID_2,
        clientId: TEST_USER_CLIENT_ID,
        labId: TEST_LAB_ID,
        serviceId: TEST_SERVICE_ID,
        status: OrderStatus.IN_PROGRESS,
        quantity: 1,
      },
    })

    const formData = new FormData()
    formData.set('orderId', TEST_ORDER_ID_2)

    // FIXED-mode: no CAPTURED Transaction → completeOrder silently skips Payout creation. (ref: AD-001)
    await completeOrder(null, formData)

    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_2 } })
    expect(order!.status).toBe(OrderStatus.COMPLETED)
    const payouts = await testPrisma.payout.findMany({ where: { orderId: TEST_ORDER_ID_2 } })
    expect(payouts).toHaveLength(0)
  })
})

describe('processPaymentFailed', () => {
  it('returns early on duplicate delivery when IdempotencyKey already exists for the EXPIRED key', async () => {
    await testPrisma.order.create({
      data: {
        id: TEST_ORDER_ID_3,
        clientId: TEST_USER_CLIENT_ID,
        labId: TEST_LAB_ID,
        serviceId: TEST_SERVICE_ID,
        status: OrderStatus.PAYMENT_PENDING,
        quantity: 1,
      },
    })
    await testPrisma.transaction.create({
      data: {
        id: 'test-tx-idem-expired',
        orderId: TEST_ORDER_ID_3,
        externalId: TEST_TX_EXTERNAL_ID_5,
        provider: 'xendit',
        amount: '1500.00',
        status: TransactionStatus.PENDING,
      },
    })
    await testPrisma.idempotencyKey.create({
      data: { key: `xendit:invoice:EXPIRED:${TEST_TX_EXTERNAL_ID_5}` },
    })

    const payload: NormalizedWebhookPayload = {
      externalId: TEST_TX_EXTERNAL_ID_5,
    }

    await processPaymentFailed(payload)

    const tx = await testPrisma.transaction.findUnique({ where: { externalId: TEST_TX_EXTERNAL_ID_5 } })
    expect(tx!.status).toBe(TransactionStatus.PENDING)
    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_3 } })
    expect(order!.status).toBe(OrderStatus.PAYMENT_PENDING)
    const keys = await testPrisma.idempotencyKey.findMany({
      where: { key: `xendit:invoice:EXPIRED:${TEST_TX_EXTERNAL_ID_5}` },
    })
    expect(keys).toHaveLength(1)
  })

  it('does NOT short-circuit when only the PAID IdempotencyKey exists for the same externalId', async () => {
    await testPrisma.order.create({
      data: {
        id: TEST_ORDER_ID_4,
        clientId: TEST_USER_CLIENT_ID,
        labId: TEST_LAB_ID,
        serviceId: TEST_SERVICE_ID,
        status: OrderStatus.PAYMENT_PENDING,
        quantity: 1,
      },
    })
    await testPrisma.transaction.create({
      data: {
        id: 'test-tx-cross-event',
        orderId: TEST_ORDER_ID_4,
        externalId: TEST_TX_EXTERNAL_ID_6,
        provider: 'xendit',
        amount: '1500.00',
        status: TransactionStatus.PENDING,
      },
    })
    await testPrisma.idempotencyKey.create({
      data: { key: `xendit:invoice:PAID:${TEST_TX_EXTERNAL_ID_6}` },
    })

    const payload: NormalizedWebhookPayload = {
      externalId: TEST_TX_EXTERNAL_ID_6,
    }

    await processPaymentFailed(payload)

    const tx = await testPrisma.transaction.findUnique({ where: { externalId: TEST_TX_EXTERNAL_ID_6 } })
    expect(tx!.status).toBe(TransactionStatus.FAILED)
    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_4 } })
    expect(order!.status).toBe(OrderStatus.PAYMENT_FAILED)
    const expiredKey = await testPrisma.idempotencyKey.findUnique({
      where: { key: `xendit:invoice:EXPIRED:${TEST_TX_EXTERNAL_ID_6}` },
    })
    expect(expiredKey).not.toBeNull()
    const paidKey = await testPrisma.idempotencyKey.findUnique({
      where: { key: `xendit:invoice:PAID:${TEST_TX_EXTERNAL_ID_6}` },
    })
    expect(paidKey).not.toBeNull()
  })

  it('marks Transaction FAILED and transitions Order to PAYMENT_FAILED', async () => {
    await testPrisma.order.create({
      data: {
        id: TEST_ORDER_ID_1,
        clientId: TEST_USER_CLIENT_ID,
        labId: TEST_LAB_ID,
        serviceId: TEST_SERVICE_ID,
        status: OrderStatus.PAYMENT_PENDING,
        quantity: 1,
      },
    })
    await testPrisma.transaction.create({
      data: {
        id: 'test-tx-failed-1',
        orderId: TEST_ORDER_ID_1,
        externalId: TEST_TX_EXTERNAL_ID_4,
        provider: 'xendit',
        amount: '1500.00',
        status: TransactionStatus.PENDING,
      },
    })

    const payload: NormalizedWebhookPayload = {
      externalId: TEST_TX_EXTERNAL_ID_4,
    }

    await processPaymentFailed(payload)

    const tx = await testPrisma.transaction.findUnique({ where: { externalId: TEST_TX_EXTERNAL_ID_4 } })
    expect(tx!.status).toBe(TransactionStatus.FAILED)
    expect(tx!.failureReason).toMatch(/EXPIRED/)
    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_1 } })
    expect(order!.status).toBe(OrderStatus.PAYMENT_FAILED)
  })

  it('is a no-op when Transaction is already FAILED (idempotency)', async () => {
    await testPrisma.order.create({
      data: {
        id: TEST_ORDER_ID_1,
        clientId: TEST_USER_CLIENT_ID,
        labId: TEST_LAB_ID,
        serviceId: TEST_SERVICE_ID,
        status: OrderStatus.PAYMENT_FAILED,
        quantity: 1,
      },
    })
    await testPrisma.transaction.create({
      data: {
        id: 'test-tx-failed-2',
        orderId: TEST_ORDER_ID_1,
        externalId: TEST_TX_EXTERNAL_ID_4,
        provider: 'xendit',
        amount: '1500.00',
        status: TransactionStatus.FAILED,
        failureReason: 'Xendit invoice EXPIRED',
      },
    })

    const payload: NormalizedWebhookPayload = {
      externalId: TEST_TX_EXTERNAL_ID_4,
    }

    await processPaymentFailed(payload)

    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_1 } })
    expect(order!.status).toBe(OrderStatus.PAYMENT_FAILED)
  })

  it('returns without error when Transaction is not found (orphan tolerance)', async () => {
    const payload: NormalizedWebhookPayload = {
      externalId: 'xendit-unknown-ext-id',
    }

    await expect(processPaymentFailed(payload)).resolves.not.toThrow()
  })
})
