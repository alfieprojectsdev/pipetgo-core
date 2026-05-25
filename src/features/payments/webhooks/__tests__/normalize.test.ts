import { describe, it, expect } from 'vitest'
import { normalizeXenditInvoicePayload } from '../types'
import type { XenditInvoicePayload } from '../types'

describe('normalizeXenditInvoicePayload', () => {
  it('maps id to externalId and payment_method to paymentMethod', () => {
    const raw: XenditInvoicePayload = {
      id: 'xendit-inv-abc',
      status: 'PAID',
      paid_amount: 1500,
      payer_email: 'client@test.local',
      payment_method: 'CREDIT_CARD',
    }

    const result = normalizeXenditInvoicePayload(raw)

    expect(result.externalId).toBe('xendit-inv-abc')
    expect(result.paymentMethod).toBe('CREDIT_CARD')
  })

  it('produces undefined paymentMethod when payment_method is absent', () => {
    const raw: XenditInvoicePayload = {
      id: 'xendit-inv-def',
      status: 'EXPIRED',
      paid_amount: 0,
      payer_email: 'client@test.local',
    }

    const result = normalizeXenditInvoicePayload(raw)

    expect(result.externalId).toBe('xendit-inv-def')
    expect(result.paymentMethod).toBeUndefined()
  })

  it('throws when payload.id is null', () => {
    const raw = { id: null, status: 'PAID', paid_amount: 0, payer_email: 'x@x.com' } as unknown as XenditInvoicePayload
    expect(() => normalizeXenditInvoicePayload(raw)).toThrow(/missing required id/)
  })

  it('throws when payload.id is empty string', () => {
    const raw: XenditInvoicePayload = { id: '', status: 'PAID', paid_amount: 0, payer_email: 'x@x.com' }
    expect(() => normalizeXenditInvoicePayload(raw)).toThrow(/missing required id/)
  })

  it('throws when payload.id is a non-string value', () => {
    const raw = { id: 12345, status: 'PAID', paid_amount: 0, payer_email: 'x@x.com' } as unknown as XenditInvoicePayload
    expect(() => normalizeXenditInvoicePayload(raw)).toThrow(/missing required id/)
  })

  it('throws when payload.id is whitespace-only', () => {
    const raw: XenditInvoicePayload = { id: '   ', status: 'PAID', paid_amount: 0, payer_email: 'x@x.com' }
    expect(() => normalizeXenditInvoicePayload(raw)).toThrow(/missing required id/)
  })
})
