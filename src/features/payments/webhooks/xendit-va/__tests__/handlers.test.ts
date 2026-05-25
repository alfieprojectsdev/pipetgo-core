import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { OrderStatus, TransactionStatus, UserRole, ServiceCategory, PricingMode } from '@prisma/client'
import { testPrisma } from '@/test/test-prisma'
import { processPaymentCapture, processPaymentFailed } from '../../handlers'
import type { NormalizedWebhookPayload } from '@/lib/payments/types'

vi.mock('@/lib/prisma', async () => {
  const { testPrisma: client } = await import('@/test/test-prisma')
  return { prisma: client }
})

vi.mock('@/lib/auth', () => ({
  auth: vi.fn().mockResolvedValue({
    user: { id: 'va-test-user-lab-1', role: 'LAB_ADMIN' },
  }),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

const TEST_USER_CLIENT_ID = 'va-test-user-client-1'
const TEST_USER_LAB_ID = 'va-test-user-lab-1'
const TEST_LAB_ID = 'va-test-lab-1'
const TEST_SERVICE_ID = 'va-test-service-1'
const TEST_ORDER_ID_1 = 'va-test-order-1'
const TEST_ORDER_ID_2 = 'va-test-order-2'
const TEST_FVA_EXT_ID = 'xendit-fva-test-ext-1'
const TEST_FVA_EXT_ID_2 = 'xendit-fva-test-ext-2'

async function cleanup() {
  await testPrisma.idempotencyKey.deleteMany({
    where: {
      key: {
        in: [
          `xendit:va:PAID:${TEST_FVA_EXT_ID}`,
          `xendit:va:EXPIRED:${TEST_FVA_EXT_ID}`,
          `xendit:va:PAID:${TEST_FVA_EXT_ID_2}`,
          `xendit:va:EXPIRED:${TEST_FVA_EXT_ID_2}`,
          `xendit:invoice:PAID:${TEST_FVA_EXT_ID}`,
          `xendit:invoice:EXPIRED:${TEST_FVA_EXT_ID}`,
        ],
      },
    },
  })
  await testPrisma.transaction.deleteMany({
    where: { externalId: { in: [TEST_FVA_EXT_ID, TEST_FVA_EXT_ID_2] } },
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
      { id: TEST_USER_CLIENT_ID, email: 'va-client@test.local', role: UserRole.CLIENT },
      { id: TEST_USER_LAB_ID, email: 'va-lab@test.local', role: UserRole.LAB_ADMIN },
    ],
    skipDuplicates: true,
  })
  await testPrisma.lab.upsert({
    where: { id: TEST_LAB_ID },
    update: {},
    create: { id: TEST_LAB_ID, ownerId: TEST_USER_LAB_ID, name: 'VA Test Lab' },
  })
  await testPrisma.labService.upsert({
    where: { id: TEST_SERVICE_ID },
    update: {},
    create: {
      id: TEST_SERVICE_ID,
      labId: TEST_LAB_ID,
      name: 'VA Test Service',
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

describe('xendit-va webhook — processPaymentCapture (COMPLETED)', () => {
  it('creates xendit:va:PAID key and advances Transaction to CAPTURED', async () => {
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
        id: 'va-test-tx-1',
        orderId: TEST_ORDER_ID_1,
        externalId: TEST_FVA_EXT_ID,
        provider: 'xendit-va',
        amount: '1500.00',
        status: TransactionStatus.PENDING,
        vaNumber: '8001234567890',
      },
    })

    const payload: NormalizedWebhookPayload = {
      externalId: TEST_FVA_EXT_ID,
      paymentMethod: 'BPI',
      idempotencyKeyPrefix: 'xendit:va',
    }

    await processPaymentCapture(payload)

    const tx = await testPrisma.transaction.findUnique({ where: { externalId: TEST_FVA_EXT_ID } })
    expect(tx!.status).toBe(TransactionStatus.CAPTURED)

    const key = await testPrisma.idempotencyKey.findUnique({
      where: { key: `xendit:va:PAID:${TEST_FVA_EXT_ID}` },
    })
    expect(key).not.toBeNull()
  })
})

describe('xendit-va webhook — processPaymentFailed (EXPIRED)', () => {
  it('creates xendit:va:EXPIRED key and transitions Order to PAYMENT_FAILED', async () => {
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
        id: 'va-test-tx-2',
        orderId: TEST_ORDER_ID_2,
        externalId: TEST_FVA_EXT_ID_2,
        provider: 'xendit-va',
        amount: '1500.00',
        status: TransactionStatus.PENDING,
        vaNumber: '8009876543210',
      },
    })

    const payload: NormalizedWebhookPayload = {
      externalId: TEST_FVA_EXT_ID_2,
      idempotencyKeyPrefix: 'xendit:va',
      failureReason: 'Xendit VA EXPIRED',
    }

    await processPaymentFailed(payload)

    const tx = await testPrisma.transaction.findUnique({ where: { externalId: TEST_FVA_EXT_ID_2 } })
    expect(tx!.status).toBe(TransactionStatus.FAILED)

    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_2 } })
    expect(order!.status).toBe(OrderStatus.PAYMENT_FAILED)

    const key = await testPrisma.idempotencyKey.findUnique({
      where: { key: `xendit:va:EXPIRED:${TEST_FVA_EXT_ID_2}` },
    })
    expect(key).not.toBeNull()
  })
})

describe('xendit-va webhook — namespace isolation', () => {
  it('does NOT create a xendit:invoice:PAID key after a VA COMPLETED event', async () => {
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
        id: 'va-test-tx-ns',
        orderId: TEST_ORDER_ID_1,
        externalId: TEST_FVA_EXT_ID,
        provider: 'xendit-va',
        amount: '1500.00',
        status: TransactionStatus.PENDING,
        vaNumber: '8001234567890',
      },
    })

    const payload: NormalizedWebhookPayload = {
      externalId: TEST_FVA_EXT_ID,
      paymentMethod: 'BPI',
      idempotencyKeyPrefix: 'xendit:va',
    }

    await processPaymentCapture(payload)

    const invoiceKey = await testPrisma.idempotencyKey.findUnique({
      where: { key: `xendit:invoice:PAID:${TEST_FVA_EXT_ID}` },
    })
    expect(invoiceKey).toBeNull()

    const vaKey = await testPrisma.idempotencyKey.findUnique({
      where: { key: `xendit:va:PAID:${TEST_FVA_EXT_ID}` },
    })
    expect(vaKey).not.toBeNull()
  })
})
