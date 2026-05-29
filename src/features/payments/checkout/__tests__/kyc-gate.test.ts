/**
 * Unit tests for the KYC gate in initiateCheckout and initiateVaCheckout.
 * Verifies that labs without APPROVED kycStatus cannot proceed to payment.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { OrderStatus, TransactionStatus, KycStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

const mocks = vi.hoisted(() => ({
  orderFindUnique: vi.fn(),
  transactionFindFirst: vi.fn(),
  transactionCreate: vi.fn(),
  auth: vi.fn(),
  createXenditInvoice: vi.fn(),
  createXenditVa: vi.fn(),
  redirect: vi.fn(),
  isPesonetBankCode: vi.fn().mockReturnValue(true),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    order: { findUnique: mocks.orderFindUnique },
    transaction: {
      findFirst: mocks.transactionFindFirst,
      create: mocks.transactionCreate,
    },
  },
}))

vi.mock('@/lib/auth', () => ({
  auth: mocks.auth,
}))

vi.mock('@/lib/payments/xendit', () => ({
  createXenditInvoice: mocks.createXenditInvoice,
  XenditApiError: class XenditApiError extends Error {
    constructor(message: string, public status: number, public body: unknown) {
      super(message)
      this.name = 'XenditApiError'
    }
  },
}))

vi.mock('@/lib/payments/xendit-va', () => ({
  createXenditVa: mocks.createXenditVa,
  XenditVaError: class XenditVaError extends Error {
    constructor(message: string, public status: number, public body: unknown) {
      super(message)
      this.name = 'XenditVaError'
    }
  },
}))

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}))

vi.mock('@/domain/payments/pesonet', () => ({
  isPesonetBankCode: mocks.isPesonetBankCode,
  PESONET_MIN_AMOUNT: 50_000,
}))

import { initiateCheckout, initiateVaCheckout } from '../action'
import { auth } from '@/lib/auth'

const mockAuth = auth as unknown as Mock

const CLIENT_SESSION = {
  user: { id: 'client-user-id', role: 'CLIENT' },
  expires: '2099-01-01',
}

const ORDER_ID = 'test-order-id'

function makeCheckoutFormData(orderId = ORDER_ID): FormData {
  const fd = new FormData()
  fd.append('orderId', orderId)
  return fd
}

function makeVaFormData(orderId = ORDER_ID, bankCode = 'BPI'): FormData {
  const fd = new FormData()
  fd.append('orderId', orderId)
  fd.append('bankCode', bankCode)
  return fd
}

function makeOrder(kycStatus: KycStatus, labOverride?: object | null) {
  const lab = labOverride === null
    ? null
    : { id: 'lab-1', kycStatus, ...(labOverride ?? {}) }
  return {
    id: ORDER_ID,
    clientId: 'client-user-id',
    status: OrderStatus.PAYMENT_PENDING,
    quotedPrice: new Decimal('1500.00'),
    clientProfile: { email: 'client@example.com' },
    service: { name: 'CBC Test' },
    lab,
  }
}

function makeVaOrder(kycStatus: KycStatus, labOverride?: object | null) {
  const lab = labOverride === null
    ? null
    : { id: 'lab-1', kycStatus, ...(labOverride ?? {}) }
  return {
    id: ORDER_ID,
    clientId: 'client-user-id',
    status: OrderStatus.PAYMENT_PENDING,
    quotedPrice: new Decimal('60000.00'),
    service: { name: 'CBC Test' },
    lab,
  }
}

describe('initiateCheckout — KYC gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.redirect.mockImplementation(() => {
      throw Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT' })
    })
    mocks.createXenditInvoice.mockResolvedValue({
      invoiceId: 'xendit-inv-1',
      invoiceUrl: 'https://checkout.xendit.co/test',
      rawResponse: {},
    })
    mocks.transactionCreate.mockResolvedValue({})
    mocks.transactionFindFirst.mockResolvedValue(null)
  })

  it('kycStatus PENDING returns KYC error, Xendit NOT called', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.orderFindUnique.mockResolvedValue(makeOrder(KycStatus.PENDING))

    const result = await initiateCheckout(null, makeCheckoutFormData())

    expect(result).toEqual({ message: 'This lab is not yet verified. Payment cannot proceed.' })
    expect(mocks.createXenditInvoice).not.toHaveBeenCalled()
  })

  it('kycStatus SUBMITTED returns KYC error, Xendit NOT called', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.orderFindUnique.mockResolvedValue(makeOrder(KycStatus.SUBMITTED))

    const result = await initiateCheckout(null, makeCheckoutFormData())

    expect(result).toEqual({ message: 'This lab is not yet verified. Payment cannot proceed.' })
    expect(mocks.createXenditInvoice).not.toHaveBeenCalled()
  })

  it('kycStatus REJECTED returns KYC error, Xendit NOT called', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.orderFindUnique.mockResolvedValue(makeOrder(KycStatus.REJECTED))

    const result = await initiateCheckout(null, makeCheckoutFormData())

    expect(result).toEqual({ message: 'This lab is not yet verified. Payment cannot proceed.' })
    expect(mocks.createXenditInvoice).not.toHaveBeenCalled()
  })

  it('kycStatus APPROVED — Xendit IS called', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.orderFindUnique.mockResolvedValue(makeOrder(KycStatus.APPROVED))

    await expect(initiateCheckout(null, makeCheckoutFormData())).rejects.toThrow('NEXT_REDIRECT')
    expect(mocks.createXenditInvoice).toHaveBeenCalledTimes(1)
  })

  it('KYC gate preempts idempotency check — PENDING transaction exists but unverified lab returns KYC error', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.orderFindUnique.mockResolvedValue(makeOrder(KycStatus.PENDING))
    mocks.transactionFindFirst.mockResolvedValue({
      id: 'existing-tx',
      status: TransactionStatus.PENDING,
      checkoutUrl: 'https://checkout.xendit.co/existing',
    })

    const result = await initiateCheckout(null, makeCheckoutFormData())

    expect(result).toEqual({ message: 'This lab is not yet verified. Payment cannot proceed.' })
    expect(mocks.transactionFindFirst).not.toHaveBeenCalled()
    expect(mocks.createXenditInvoice).not.toHaveBeenCalled()
  })

  it('order.lab === null after explicit include throws referential integrity error', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.orderFindUnique.mockResolvedValue(makeOrder(KycStatus.PENDING, null))

    await expect(initiateCheckout(null, makeCheckoutFormData())).rejects.toThrow(
      'Order.lab missing after explicit include — referential integrity violation',
    )
    expect(mocks.createXenditInvoice).not.toHaveBeenCalled()
  })
})

describe('initiateVaCheckout — KYC gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isPesonetBankCode.mockReturnValue(true)
    mocks.redirect.mockImplementation(() => {
      throw Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT' })
    })
    mocks.createXenditVa.mockResolvedValue({
      vaId: 'va-1',
      accountNumber: '8001234567890',
      bankCode: 'BPI',
      externalId: 'tx-1',
      rawResponse: {},
    })
    mocks.transactionCreate.mockResolvedValue({})
    mocks.transactionFindFirst.mockResolvedValue(null)
  })

  it('kycStatus PENDING returns KYC error, Xendit VA NOT called', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.orderFindUnique.mockResolvedValue(makeVaOrder(KycStatus.PENDING))

    const result = await initiateVaCheckout(null, makeVaFormData())

    expect(result).toEqual({ message: 'This lab is not yet verified. Payment cannot proceed.' })
    expect(mocks.createXenditVa).not.toHaveBeenCalled()
  })

  it('kycStatus SUBMITTED returns KYC error, Xendit VA NOT called', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.orderFindUnique.mockResolvedValue(makeVaOrder(KycStatus.SUBMITTED))

    const result = await initiateVaCheckout(null, makeVaFormData())

    expect(result).toEqual({ message: 'This lab is not yet verified. Payment cannot proceed.' })
    expect(mocks.createXenditVa).not.toHaveBeenCalled()
  })

  it('kycStatus REJECTED returns KYC error, Xendit VA NOT called', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.orderFindUnique.mockResolvedValue(makeVaOrder(KycStatus.REJECTED))

    const result = await initiateVaCheckout(null, makeVaFormData())

    expect(result).toEqual({ message: 'This lab is not yet verified. Payment cannot proceed.' })
    expect(mocks.createXenditVa).not.toHaveBeenCalled()
  })

  it('kycStatus APPROVED — Xendit VA IS called', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.orderFindUnique.mockResolvedValue(makeVaOrder(KycStatus.APPROVED))

    await expect(initiateVaCheckout(null, makeVaFormData())).rejects.toThrow('NEXT_REDIRECT')
    expect(mocks.createXenditVa).toHaveBeenCalledTimes(1)
  })

  it('KYC gate preempts idempotency check — PENDING transaction exists but unverified lab returns KYC error', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.orderFindUnique.mockResolvedValue(makeVaOrder(KycStatus.PENDING))
    mocks.transactionFindFirst.mockResolvedValue({
      id: 'existing-tx',
      status: TransactionStatus.PENDING,
    })

    const result = await initiateVaCheckout(null, makeVaFormData())

    expect(result).toEqual({ message: 'This lab is not yet verified. Payment cannot proceed.' })
    expect(mocks.transactionFindFirst).not.toHaveBeenCalled()
    expect(mocks.createXenditVa).not.toHaveBeenCalled()
  })

  it('order.lab === null after explicit include throws referential integrity error', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.orderFindUnique.mockResolvedValue(makeVaOrder(KycStatus.PENDING, null))

    await expect(initiateVaCheckout(null, makeVaFormData())).rejects.toThrow(
      'Order.lab missing after explicit include — referential integrity violation',
    )
    expect(mocks.createXenditVa).not.toHaveBeenCalled()
  })
})
