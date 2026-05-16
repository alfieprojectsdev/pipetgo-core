/**
 * Integration tests for completeOrder — Payout and LabWallet.pendingBalance atomicity.
 * Validates the M-0 invariant: pendingBalance must be credited at Payout-QUEUED creation
 * time so processSettlement can decrement atomically without a zero-balance window.
 * Real DB (testPrisma) required for Decimal arithmetic and FK constraint validation. (ref: DL-011)
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { OrderStatus, TransactionStatus, UserRole, ServiceCategory, PricingMode, PayoutStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'
import { testPrisma } from '@/test/test-prisma'
import { completeOrder } from '../action'

vi.mock('@/lib/prisma', async () => {
  const { testPrisma: client } = await import('@/test/test-prisma')
  return { prisma: client }
})

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

const TEST_USER_CLIENT_ID = 'test-lf-client-1'
const TEST_USER_LAB_ID = 'test-lf-lab-user-1'
const TEST_LAB_ID = 'test-lf-lab-1'
const TEST_SERVICE_ID = 'test-lf-svc-1'
const TEST_ORDER_ID_1 = 'test-lf-order-1'
const TEST_ORDER_ID_2 = 'test-lf-order-2'
const TEST_TX_ID_1 = 'test-lf-tx-1'
const TEST_TX_ID_2 = 'test-lf-tx-2'
const TEST_TX_EXT_1 = 'xendit-lf-ext-1'
const TEST_TX_EXT_2 = 'xendit-lf-ext-2'

async function cleanup() {
  await testPrisma.payout.deleteMany({ where: { orderId: { in: [TEST_ORDER_ID_1, TEST_ORDER_ID_2] } } })
  await testPrisma.labWallet.deleteMany({ where: { labId: TEST_LAB_ID } })
  await testPrisma.transaction.deleteMany({ where: { id: { in: [TEST_TX_ID_1, TEST_TX_ID_2] } } })
  await testPrisma.order.deleteMany({ where: { id: { in: [TEST_ORDER_ID_1, TEST_ORDER_ID_2] } } })
  await testPrisma.labService.deleteMany({ where: { id: TEST_SERVICE_ID } })
  await testPrisma.lab.deleteMany({ where: { id: TEST_LAB_ID } })
  await testPrisma.user.deleteMany({ where: { id: { in: [TEST_USER_CLIENT_ID, TEST_USER_LAB_ID] } } })
}

async function seedBase() {
  await testPrisma.user.createMany({
    data: [
      { id: TEST_USER_CLIENT_ID, email: 'lf-client@test.local', role: UserRole.CLIENT },
      { id: TEST_USER_LAB_ID, email: 'lf-lab@test.local', role: UserRole.LAB_ADMIN },
    ],
    skipDuplicates: true,
  })
  await testPrisma.lab.upsert({
    where: { id: TEST_LAB_ID },
    update: {},
    create: { id: TEST_LAB_ID, ownerId: TEST_USER_LAB_ID, name: 'Test Lab LF' },
  })
  await testPrisma.labService.upsert({
    where: { id: TEST_SERVICE_ID },
    update: {},
    create: {
      id: TEST_SERVICE_ID,
      labId: TEST_LAB_ID,
      name: 'Test Service LF',
      category: ServiceCategory.CHEMICAL_TESTING,
      pricingMode: PricingMode.FIXED,
    },
  })
}

vi.mock('@/lib/auth', () => ({
  auth: vi.fn().mockResolvedValue({
    user: { id: TEST_USER_LAB_ID, role: 'LAB_ADMIN' },
  }),
}))

beforeEach(async () => {
  await cleanup()
  await seedBase()
})

afterAll(async () => {
  await cleanup()
  await testPrisma.$disconnect()
})

describe('completeOrder — Payout and LabWallet writes', () => {
  it('creates Payout(QUEUED) and LabWallet.pendingBalance on first order completion', async () => {
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
        id: TEST_TX_ID_1,
        orderId: TEST_ORDER_ID_1,
        externalId: TEST_TX_EXT_1,
        provider: 'xendit',
        amount: '1500.00',
        status: TransactionStatus.CAPTURED,
        capturedAt: new Date(),
      },
    })

    const formData = new FormData()
    formData.set('orderId', TEST_ORDER_ID_1)

    await completeOrder(null, formData)

    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_1 } })
    expect(order!.status).toBe(OrderStatus.COMPLETED)

    const payout = await testPrisma.payout.findFirst({ where: { orderId: TEST_ORDER_ID_1 } })
    expect(payout).not.toBeNull()
    expect(payout!.status).toBe(PayoutStatus.QUEUED)
    expect(payout!.externalPayoutId).toBeNull()
    const gross = new Decimal('1500.00')
    const fee = gross.mul(new Decimal('0.1000'))
    expect(payout!.platformFee.toFixed(2)).toBe(fee.toFixed(2))
    expect(payout!.netAmount.toFixed(2)).toBe(gross.sub(fee).toFixed(2))

    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
    expect(wallet).not.toBeNull()
    expect(wallet!.pendingBalance.toFixed(2)).toBe(fee.toFixed(2))
  })

  it('increments LabWallet.pendingBalance on second order completion for the same lab', async () => {
    const fee = new Decimal('1500.00').mul(new Decimal('0.1000'))
    await testPrisma.labWallet.create({
      data: { labId: TEST_LAB_ID, pendingBalance: fee.toString() },
    })
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
    await testPrisma.transaction.create({
      data: {
        id: TEST_TX_ID_2,
        orderId: TEST_ORDER_ID_2,
        externalId: TEST_TX_EXT_2,
        provider: 'xendit',
        amount: '1500.00',
        status: TransactionStatus.CAPTURED,
        capturedAt: new Date(),
      },
    })

    const formData = new FormData()
    formData.set('orderId', TEST_ORDER_ID_2)

    await completeOrder(null, formData)

    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
    expect(wallet!.pendingBalance.toFixed(2)).toBe(fee.add(fee).toFixed(2))
  })
})
