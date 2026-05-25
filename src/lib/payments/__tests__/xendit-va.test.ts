import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createXenditVa, XenditVaError } from '../xendit-va'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => {
  vi.resetAllMocks()
  process.env.XENDIT_SECRET_KEY = 'test_key'
})

afterEach(() => {
  process.env.XENDIT_SECRET_KEY = 'test_key'
})

describe('createXenditVa', () => {
  it('returns correct result shape on success', async () => {
    const fakeResponse = {
      id: 'va-123',
      account_number: '8001234567890',
      bank_code: 'BCA',
      external_id: 'txn-ext-1',
      name: 'Test User',
    }
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => fakeResponse,
    })

    const result = await createXenditVa({
      externalId: 'txn-ext-1',
      bankCode: 'BCA',
      name: 'Test User',
      expectedAmount: 1500,
      expirationDate: new Date('2026-12-31T00:00:00Z'),
    })

    expect(result.vaId).toBe('va-123')
    expect(result.accountNumber).toBe('8001234567890')
    expect(result.bankCode).toBe('BCA')
    expect(result.externalId).toBe('txn-ext-1')
    expect(result.rawResponse).toEqual(fakeResponse)
  })

  it('request body includes is_closed: true and expected_amount as a number', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'va-456',
        account_number: '8009876543210',
        bank_code: 'BPI',
        external_id: 'txn-ext-2',
      }),
    })

    await createXenditVa({
      externalId: 'txn-ext-2',
      bankCode: 'BPI',
      name: 'Another User',
      expectedAmount: 2500,
      expirationDate: new Date('2026-12-31T00:00:00Z'),
    })

    expect(mockFetch).toHaveBeenCalledOnce()
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(options.body as string) as Record<string, unknown>
    expect(body['is_closed']).toBe(true)
    expect(body['expected_amount']).toBe(2500)
    expect(typeof body['expected_amount']).toBe('number')
  })

  it('throws XenditVaError on non-2xx response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => '{"error_code":"API_VALIDATION_ERROR"}',
    })

    await expect(
      createXenditVa({
        externalId: 'txn-ext-3',
        bankCode: 'BCA',
        name: 'Test User',
        expectedAmount: 500,
        expirationDate: new Date('2026-12-31T00:00:00Z'),
      }),
    ).rejects.toThrow(XenditVaError)
  })

  it('throws XenditVaError with status 500 when XENDIT_SECRET_KEY is absent', async () => {
    delete process.env.XENDIT_SECRET_KEY

    await expect(
      createXenditVa({
        externalId: 'txn-ext-4',
        bankCode: 'BCA',
        name: 'Test User',
        expectedAmount: 500,
        expirationDate: new Date('2026-12-31T00:00:00Z'),
      }),
    ).rejects.toThrow(XenditVaError)

    await expect(
      createXenditVa({
        externalId: 'txn-ext-4',
        bankCode: 'BCA',
        name: 'Test User',
        expectedAmount: 500,
        expirationDate: new Date('2026-12-31T00:00:00Z'),
      }),
    ).rejects.toMatchObject({ status: 500 })
  })
})
