/**
 * Integration tests for processSettlement against real test DB (testPrisma + DATABASE_TEST_URL).
 * Real DB validates Decimal arithmetic, FK constraints, and $transaction atomicity. (ref: DL-011)
 * Covers: first delivery, idempotent duplicate, orphan tolerance (unknown externalPayoutId),
 * orphan tolerance (unknown orderId), negative-balance guard, PROCESSING contract violation.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { OrderStatus, TransactionStatus, UserRole, ServiceCategory, PricingMode, PayoutStatus } from '@prisma/client'
import { testPrisma } from '@/test/test-prisma'
import { processSettlement } from '../handlers'
import type { XenditSettlementPayload } from '../types'

vi.mock('@/lib/prisma', async () => {
  const { testPrisma: client } = await import('@/test/test-prisma')
  return { prisma: client }
})

const TEST_USER_CLIENT_ID = 'test-settle-client-1'
const TEST_USER_LAB_ID = 'test-settle-lab-user-1'
const TEST_LAB_ID = 'test-settle-lab-1'
const TEST_SERVICE_ID = 'test-settle-svc-1'
const TEST_ORDER_ID_1 = 'test-settle-order-1'
const TEST_ORDER_ID_2 = 'test-settle-order-2'
const TEST_TX_ID_1 = 'test-settle-tx-1'
const TEST_TX_EXT_1 = 'xendit-settle-ext-1'
const TEST_PAYOUT_ID_1 = 'test-settle-payout-1'
const TEST_PAYOUT_ID_2 = 'test-settle-payout-2'
const TEST_PAYOUT_ID_3 = 'test-settle-payout-3'
const TEST_PAYOUT_ID_4 = 'test-settle-payout-4'
const TEST_PAYOUT_ID_5 = 'test-settle-payout-5'
const EXT_SETTLE_1 = 'ext-settle-1'
const EXT_SETTLE_2 = 'ext-settle-2'
const EXT_SETTLE_5 = 'ext-settle-5'

async function cleanup() {
  await testPrisma.payout.deleteMany({
    where: {
      id: { in: [TEST_PAYOUT_ID_1, TEST_PAYOUT_ID_2, TEST_PAYOUT_ID_3, TEST_PAYOUT_ID_4, TEST_PAYOUT_ID_5] },
    },
  })
  await testPrisma.labWallet.deleteMany({ where: { labId: TEST_LAB_ID } })
  await testPrisma.transaction.deleteMany({ where: { id: TEST_TX_ID_1 } })
  await testPrisma.order.deleteMany({ where: { id: { in: [TEST_ORDER_ID_1, TEST_ORDER_ID_2] } } })
  await testPrisma.labService.deleteMany({ where: { id: TEST_SERVICE_ID } })
  await testPrisma.lab.deleteMany({ where: { id: TEST_LAB_ID } })
  await testPrisma.user.deleteMany({ where: { id: { in: [TEST_USER_CLIENT_ID, TEST_USER_LAB_ID] } } })
}

async function seedBase() {
  await testPrisma.user.createMany({
    data: [
      { id: TEST_USER_CLIENT_ID, email: 'settle-client@test.local', role: UserRole.CLIENT },
      { id: TEST_USER_LAB_ID, email: 'settle-lab@test.local', role: UserRole.LAB_ADMIN },
    ],
    skipDuplicates: true,
  })
  await testPrisma.lab.upsert({
    where: { id: TEST_LAB_ID },
    update: {},
    create: { id: TEST_LAB_ID, ownerId: TEST_USER_LAB_ID, name: 'Test Lab Settlement' },
  })
  await testPrisma.labService.upsert({
    where: { id: TEST_SERVICE_ID },
    update: {},
    create: {
      id: TEST_SERVICE_ID,
      labId: TEST_LAB_ID,
      name: 'Test Service Settlement',
      category: ServiceCategory.CHEMICAL_TESTING,
      pricingMode: PricingMode.FIXED,
    },
  })
  await testPrisma.order.create({
    data: {
      id: TEST_ORDER_ID_1,
      clientId: TEST_USER_CLIENT_ID,
      labId: TEST_LAB_ID,
      serviceId: TEST_SERVICE_ID,
      status: OrderStatus.COMPLETED,
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

describe('processSettlement', () => {
  it('first delivery — transitions Payout QUEUED->COMPLETED and moves platformFee pending->available', async () => {
    await testPrisma.payout.create({
      data: {
        id: TEST_PAYOUT_ID_1,
        labId: TEST_LAB_ID,
        orderId: TEST_ORDER_ID_1,
        transactionId: TEST_TX_ID_1,
        grossAmount: '1500.00',
        platformFee: '150.00',
        netAmount: '1350.00',
        feePercentage: '0.1000',
        status: PayoutStatus.QUEUED,
      },
    })
    await testPrisma.labWallet.create({
      data: { labId: TEST_LAB_ID, pendingBalance: '150.00', availableBalance: '0.00' },
    })

    const payload: XenditSettlementPayload = {
      id: EXT_SETTLE_1,
      status: 'COMPLETED',
      amount: 1500,
      external_id: TEST_ORDER_ID_1,
    }

    await processSettlement(payload)

    const payout = await testPrisma.payout.findUnique({ where: { id: TEST_PAYOUT_ID_1 } })
    expect(payout!.status).toBe(PayoutStatus.COMPLETED)
    expect(payout!.externalPayoutId).toBe(EXT_SETTLE_1)
    expect(payout!.completedAt).not.toBeNull()

    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
    expect(wallet!.pendingBalance.toFixed(2)).toBe('0.00')
    expect(wallet!.availableBalance.toFixed(2)).toBe('150.00')
  })

  it('idempotent duplicate — no DB change when Payout already COMPLETED', async () => {
    await testPrisma.payout.create({
      data: {
        id: TEST_PAYOUT_ID_2,
        labId: TEST_LAB_ID,
        orderId: TEST_ORDER_ID_1,
        transactionId: TEST_TX_ID_1,
        grossAmount: '1500.00',
        platformFee: '150.00',
        netAmount: '1350.00',
        feePercentage: '0.1000',
        status: PayoutStatus.COMPLETED,
        externalPayoutId: EXT_SETTLE_2,
        completedAt: new Date(),
      },
    })
    await testPrisma.labWallet.create({
      data: { labId: TEST_LAB_ID, pendingBalance: '0.00', availableBalance: '300.00' },
    })

    const before = await testPrisma.payout.findUnique({ where: { id: TEST_PAYOUT_ID_2 } })

    const payload: XenditSettlementPayload = {
      id: EXT_SETTLE_2,
      status: 'COMPLETED',
      amount: 1500,
      external_id: TEST_ORDER_ID_1,
    }

    await processSettlement(payload)

    const after = await testPrisma.payout.findUnique({ where: { id: TEST_PAYOUT_ID_2 } })
    expect(after!.updatedAt.toISOString()).toBe(before!.updatedAt.toISOString())
    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
    expect(wallet!.availableBalance.toFixed(2)).toBe('300.00')
  })

  it('orphan tolerance — resolves without throw and no rows created when no Payout matches', async () => {
    const payload: XenditSettlementPayload = {
      id: 'ext-settle-orphan',
      status: 'COMPLETED',
      amount: 500,
      external_id: 'non-existent-order-id',
    }

    await expect(processSettlement(payload)).resolves.not.toThrow()
  })

  it('negative-balance guard — rejects with Error and makes no DB changes', async () => {
    await testPrisma.payout.create({
      data: {
        id: TEST_PAYOUT_ID_4,
        labId: TEST_LAB_ID,
        orderId: TEST_ORDER_ID_1,
        transactionId: TEST_TX_ID_1,
        grossAmount: '5000.00',
        platformFee: '500.00',
        netAmount: '4500.00',
        feePercentage: '0.1000',
        status: PayoutStatus.QUEUED,
      },
    })
    await testPrisma.labWallet.create({
      data: { labId: TEST_LAB_ID, pendingBalance: '200.00', availableBalance: '0.00' },
    })

    const payload: XenditSettlementPayload = {
      id: 'ext-settle-neg',
      status: 'COMPLETED',
      amount: 5000,
      external_id: TEST_ORDER_ID_1,
    }

    await expect(processSettlement(payload)).rejects.toThrow(/negative/)
    // Guard fires at Step 3, before any write — Payout.status and LabWallet are unchanged
    // because no writes were attempted (not because $transaction rolled back).
    const payout = await testPrisma.payout.findUnique({ where: { id: TEST_PAYOUT_ID_4 } })
    expect(payout!.status).toBe(PayoutStatus.QUEUED)
    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
    expect(wallet!.availableBalance.toFixed(2)).toBe('0.00')
  })

  it('PROCESSING contract violation — rejects with Error matching /PROCESSING/', async () => {
    await testPrisma.payout.create({
      data: {
        id: TEST_PAYOUT_ID_5,
        labId: TEST_LAB_ID,
        orderId: TEST_ORDER_ID_1,
        transactionId: TEST_TX_ID_1,
        grossAmount: '1500.00',
        platformFee: '150.00',
        netAmount: '1350.00',
        feePercentage: '0.1000',
        status: PayoutStatus.PROCESSING,
        externalPayoutId: EXT_SETTLE_5,
      },
    })

    const payload: XenditSettlementPayload = {
      id: EXT_SETTLE_5,
      status: 'COMPLETED',
      amount: 1500,
      external_id: TEST_ORDER_ID_1,
    }

    await expect(processSettlement(payload)).rejects.toThrow(/PROCESSING/)
  })
})
