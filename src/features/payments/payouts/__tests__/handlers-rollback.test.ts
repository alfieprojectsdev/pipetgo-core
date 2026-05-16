/**
 * Rollback error propagation tests using a full Prisma mock. (ref: DL-011)
 * Real DB cannot exercise rollback isolation without schema-breaking teardown, so mocks
 * are used for this single concern. Confirms that errors from payout.update and
 * labWallet.update propagate out of $transaction, causing Xendit to receive 500 and retry.
 */
import { describe, it, expect, vi } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { PayoutStatus } from '@prisma/client'

const mockPayoutFindUnique = vi.fn().mockResolvedValue(null)
const mockPayoutFindFirst = vi.fn().mockResolvedValue({
  id: 'mock-payout-id',
  labId: 'mock-lab-id',
  orderId: 'mock-order-id',
  platformFee: new Decimal('150.00'),
  status: PayoutStatus.QUEUED,
  externalPayoutId: null,
})
const mockWalletFindUnique = vi.fn().mockResolvedValue({
  labId: 'mock-lab-id',
  pendingBalance: new Decimal('500.00'),
  availableBalance: new Decimal('0.00'),
})
const mockPayoutUpdate = vi.fn().mockResolvedValue({})
const mockWalletUpdate = vi.fn().mockRejectedValue(new Error('wallet-update-failure'))

const mockTx = {
  payout: {
    findUnique: mockPayoutFindUnique,
    findFirst: mockPayoutFindFirst,
    update: mockPayoutUpdate,
  },
  labWallet: {
    findUnique: mockWalletFindUnique,
    update: mockWalletUpdate,
  },
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: vi.fn((callback: (tx: typeof mockTx) => Promise<void>) => callback(mockTx)),
  },
}))

import { processSettlement } from '../handlers'
import type { XenditSettlementPayload } from '../types'

const basePayload: XenditSettlementPayload = {
  id: 'ext-settle-mock',
  status: 'COMPLETED',
  amount: 1500,
  external_id: 'mock-order-id',
}

describe('processSettlement — rollback error propagation', () => {
  it('rejects with the wallet update error, confirming error propagation that triggers Prisma rollback', async () => {
    await expect(processSettlement(basePayload)).rejects.toThrow('wallet-update-failure')
  })

  it('rejects when payout.update throws, confirming error propagation triggers Prisma rollback', async () => {
    mockPayoutUpdate.mockRejectedValueOnce(new Error('payout-update-failure'))

    await expect(processSettlement(basePayload)).rejects.toThrow('payout-update-failure')
  })
})
