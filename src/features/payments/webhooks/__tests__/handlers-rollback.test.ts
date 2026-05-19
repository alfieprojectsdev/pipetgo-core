import { describe, it, expect, vi } from 'vitest'
import { Decimal } from '@prisma/client/runtime/library'
import { OrderStatus, TransactionStatus } from '@prisma/client'

const mockTxTransactionUpdate = vi.fn().mockRejectedValue(new Error('transaction update failure'))
const mockTxOrderUpdate = vi.fn().mockRejectedValue(new Error('order update failure'))
const mockTxTransactionFindUnique = vi.fn().mockResolvedValue({
  id: 'mock-tx-id',
  externalId: 'xendit-mock-ext',
  orderId: 'mock-order-id',
  amount: new Decimal('750.00'),
  status: TransactionStatus.PENDING,
})

const mockTx = {
  transaction: {
    findUnique: mockTxTransactionFindUnique,
    update: mockTxTransactionUpdate,
  },
  order: {
    update: mockTxOrderUpdate,
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

vi.mock('@/domain/orders/state-machine', () => ({
  isValidStatusTransition: vi.fn().mockReturnValue(true),
}))

import { processPaymentCapture, processPaymentFailed } from '../handlers'
import type { XenditInvoicePayload } from '../types'

describe('processPaymentCapture — rollback error propagation', () => {
  // Forces tx.transaction.update rejection to verify $transaction error propagation; no LabWallet mock needed under AD-001. (ref: DL-009)
  it('rejects with the transaction update error, confirming error propagation that triggers Prisma rollback', async () => {
    const payload: XenditInvoicePayload = {
      id: 'xendit-mock-ext',
      status: 'PAID',
      paid_amount: 750,
      payer_email: 'lab@test.local',
    }

    await expect(processPaymentCapture(payload)).rejects.toThrow('transaction update failure')
  })
})

describe('processPaymentFailed — rollback error propagation', () => {
  it('rejects when order.update throws, confirming error propagation triggers Prisma rollback', async () => {
    const payload: XenditInvoicePayload = {
      id: 'xendit-mock-ext',
      status: 'EXPIRED',
      paid_amount: 0,
      payer_email: 'client@test.local',
    }

    await expect(processPaymentFailed(payload)).rejects.toThrow('order update failure')
  })
})
