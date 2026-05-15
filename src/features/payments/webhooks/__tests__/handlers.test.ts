import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { OrderStatus, TransactionStatus, UserRole, ServiceCategory, PricingMode, PayoutStatus } from '@prisma/client'
import { testPrisma } from '@/test/test-prisma'
import { processPaymentCapture, processPaymentFailed } from '../handlers'
import { completeOrder } from '@/features/orders/lab-fulfillment/action'
import { isRedirectError } from 'next/dist/client/components/redirect'
import type { XenditInvoicePayload } from '../types'

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

async function cleanup() {
  await testPrisma.payout.deleteMany({ where: { orderId: { in: [TEST_ORDER_ID_1, TEST_ORDER_ID_2] } } })
  await testPrisma.labWallet.deleteMany({ where: { labId: TEST_LAB_ID } })
  await testPrisma.transaction.deleteMany({
    where: {
      externalId: {
        in: [TEST_TX_EXTERNAL_ID_1, TEST_TX_EXTERNAL_ID_2, TEST_TX_EXTERNAL_ID_3, TEST_TX_EXTERNAL_ID_4],
      },
    },
  })
  await testPrisma.order.deleteMany({
    where: { id: { in: [TEST_ORDER_ID_1, TEST_ORDER_ID_2] } },
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

    const payload: XenditInvoicePayload = {
      id: TEST_TX_EXTERNAL_ID_1,
      status: 'PAID',
      paid_amount: 1500,
      payer_email: 'client@test.local',
      payment_method: 'CREDIT_CARD',
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

    const payload: XenditInvoicePayload = {
      id: TEST_TX_EXTERNAL_ID_2,
      status: 'PAID',
      paid_amount: 1500,
      payer_email: 'client@test.local',
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

    const payload: XenditInvoicePayload = {
      id: TEST_TX_EXTERNAL_ID_3,
      status: 'PAID',
      paid_amount: 1500,
      payer_email: 'client@test.local',
    }

    await processPaymentCapture(payload)

    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
    expect(wallet).toBeNull()
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

    const payload: XenditInvoicePayload = {
      id: TEST_TX_EXTERNAL_ID_4,
      status: 'PAID',
      paid_amount: 1500,
      payer_email: 'client@test.local',
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

    try {
      await completeOrder(null, formData)
    } catch (err) {
      if (!isRedirectError(err)) throw err
    }

    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_1 } })
    expect(order!.status).toBe(OrderStatus.COMPLETED)
    expect(order!.notes).toBe('Done')

    const payout = await testPrisma.payout.findFirst({ where: { orderId: TEST_ORDER_ID_1 } })
    expect(payout).not.toBeNull()
    expect(payout!.grossAmount.toFixed(2)).toBe('1500.00')
    expect(payout!.platformFee.toFixed(2)).toBe('150.00')
    expect(payout!.netAmount.toFixed(2)).toBe('1350.00')
    expect(payout!.feePercentage.toFixed(4)).toBe('0.1000')
    expect(payout!.status).toBe(PayoutStatus.QUEUED)
    expect(payout!.transactionId).toBe(TEST_TX_INTERNAL_ID)
  })

  it('throws when no CAPTURED Transaction exists for the order', async () => {
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

    await expect(completeOrder(null, formData)).rejects.toThrow(/CAPTURED Transaction/)
  })
})

describe('processPaymentFailed', () => {
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

    const payload: XenditInvoicePayload = {
      id: TEST_TX_EXTERNAL_ID_4,
      status: 'EXPIRED',
      paid_amount: 0,
      payer_email: 'client@test.local',
    }

    await processPaymentFailed(payload)

    const tx = await testPrisma.transaction.findFirst({ where: { externalId: TEST_TX_EXTERNAL_ID_4 } })
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

    const payload: XenditInvoicePayload = {
      id: TEST_TX_EXTERNAL_ID_4,
      status: 'EXPIRED',
      paid_amount: 0,
      payer_email: 'client@test.local',
    }

    await processPaymentFailed(payload)

    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_1 } })
    expect(order!.status).toBe(OrderStatus.PAYMENT_FAILED)
  })

  it('returns without error when Transaction is not found (orphan tolerance)', async () => {
    const payload: XenditInvoicePayload = {
      id: 'xendit-unknown-ext-id',
      status: 'EXPIRED',
      paid_amount: 0,
      payer_email: 'client@test.local',
    }

    await expect(processPaymentFailed(payload)).resolves.not.toThrow()
  })
})
