import { describe, it, expect } from 'vitest'
import { normalizeXenditVaPayload } from '../types'
import type { XenditVaPayload } from '../types'

describe('normalizeXenditVaPayload', () => {
  it('maps callback_virtual_account_id to externalId and sets idempotencyKeyPrefix', () => {
    const raw: XenditVaPayload = {
      callback_virtual_account_id: 'xendit-fva-abc',
      external_id: 'txn_cuid',
      status: 'COMPLETED',
      bank_code: 'BPI',
    }
    const result = normalizeXenditVaPayload(raw)
    expect(result.externalId).toBe('xendit-fva-abc')
    expect(result.paymentMethod).toBe('BPI')
    expect(result.idempotencyKeyPrefix).toBe('xendit:va')
  })

  it('produces undefined paymentMethod when bank_code absent', () => {
    const raw: XenditVaPayload = {
      callback_virtual_account_id: 'xendit-fva-def',
      external_id: 'txn_cuid',
      status: 'COMPLETED',
    }
    const result = normalizeXenditVaPayload(raw)
    expect(result.paymentMethod).toBeUndefined()
    expect(result.idempotencyKeyPrefix).toBe('xendit:va')
  })

  it('sets failureReason for EXPIRED status', () => {
    const raw: XenditVaPayload = {
      callback_virtual_account_id: 'xendit-fva-exp',
      external_id: 'txn_cuid',
      status: 'EXPIRED',
    }
    const result = normalizeXenditVaPayload(raw)
    expect(result.failureReason).toBe('Xendit VA EXPIRED')
  })

  it('sets failureReason for FAILED status', () => {
    const raw: XenditVaPayload = {
      callback_virtual_account_id: 'xendit-fva-fail',
      external_id: 'txn_cuid',
      status: 'FAILED',
    }
    const result = normalizeXenditVaPayload(raw)
    expect(result.failureReason).toBe('Xendit VA FAILED')
  })

  it('throws on null callback_virtual_account_id', () => {
    const raw = { callback_virtual_account_id: null, external_id: 'txn', status: 'COMPLETED' } as unknown as XenditVaPayload
    expect(() => normalizeXenditVaPayload(raw)).toThrow(/missing required callback_virtual_account_id/)
  })

  it('throws on empty string callback_virtual_account_id', () => {
    const raw: XenditVaPayload = { callback_virtual_account_id: '', external_id: 'txn', status: 'COMPLETED' }
    expect(() => normalizeXenditVaPayload(raw)).toThrow(/missing required callback_virtual_account_id/)
  })

  it('throws on whitespace-only callback_virtual_account_id', () => {
    const raw: XenditVaPayload = { callback_virtual_account_id: '   ', external_id: 'txn', status: 'COMPLETED' }
    expect(() => normalizeXenditVaPayload(raw)).toThrow(/missing required callback_virtual_account_id/)
  })
})
