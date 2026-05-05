import { describe, it, expect, vi } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { TransactionStatus } from '@prisma/client'

const mockTxUpdate = vi.fn().mockResolvedValue({})
const mockTxOrderFindUnique = vi.fn().mockResolvedValue({ labId: 'mock-lab-id' })
const mockTxLabWalletUpsert = vi.fn().mockRejectedValue(new Error('wallet failure'))
const mockTxTransactionFindFirst = vi.fn().mockResolvedValue({
  id: 'mock-tx-id',
  externalId: 'xendit-mock-ext',
  orderId: 'mock-order-id',
  amount: new Decimal('750.00'),
  status: TransactionStatus.PENDING,
})

const mockTx = {
  transaction: {
    findFirst: mockTxTransactionFindFirst,
    update: mockTxUpdate,
  },
  order: {
    findUnique: mockTxOrderFindUnique,
  },
  labWallet: {
    upsert: mockTxLabWalletUpsert,
  },
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: vi.fn((callback: (tx: typeof mockTx) => Promise<void>) => callback(mockTx)),
  },
}))

vi.mock('@/features/orders/handle-payment-captured/handler', () => ({
  handlePaymentCaptured: vi.fn().mockResolvedValue(undefined),
}))

import { processPaymentCapture } from '../handlers'
import type { XenditInvoicePayload } from '../types'

describe('processPaymentCapture — rollback error propagation', () => {
  it('rejects with the wallet upsert error, confirming error propagation that triggers Prisma rollback', async () => {
    const payload: XenditInvoicePayload = {
      id: 'xendit-mock-ext',
      status: 'PAID',
      paid_amount: 750,
      payer_email: 'lab@test.local',
    }

    await expect(processPaymentCapture(payload)).rejects.toThrow('wallet failure')
  })
})
