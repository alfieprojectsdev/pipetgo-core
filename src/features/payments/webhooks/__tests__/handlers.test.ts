import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { OrderStatus, TransactionStatus, UserRole, ServiceCategory, PricingMode } from '@prisma/client'
import { testPrisma } from '@/test/test-prisma'
import { processPaymentCapture, processPaymentFailed } from '../handlers'
import type { XenditInvoicePayload } from '../types'

vi.mock('@/lib/prisma', async () => {
  const { testPrisma: client } = await import('@/test/test-prisma')
  return { prisma: client }
})

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
  it('creates LabWallet with pendingBalance equal to Transaction.amount on first payment', async () => {
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
    expect(wallet).not.toBeNull()
    expect(wallet!.pendingBalance.toFixed(2)).toBe('1500.00')
  })

  it('increments pendingBalance on subsequent payment', async () => {
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
    expect(wallet!.pendingBalance.toFixed(2)).toBe('2000.00')
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
