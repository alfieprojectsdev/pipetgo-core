// Tests for requestSpecUploadUrl: covers CLIENT role gate, ownership guard,
// MIME rejection, size ceiling, pre-presign row creation, and R2 error handling.
// Each describe block isolates one guard. (ref: DL-003, DL-007)

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

const mocks = vi.hoisted(() => ({
  orderFindUnique:         vi.fn(),
  attachmentCreate:        vi.fn(),
  auth:                    vi.fn(),
  generatePresignedPutUrl: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    order:      { findUnique: mocks.orderFindUnique },
    attachment: { create:     mocks.attachmentCreate },
  },
}))

vi.mock('@/lib/auth', () => ({ auth: mocks.auth }))

vi.mock('@/lib/storage/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage/r2')>()
  return {
    ...actual,
    generatePresignedPutUrl: mocks.generatePresignedPutUrl,
  }
})

import { requestSpecUploadUrl } from '../upload-action'
import { auth } from '@/lib/auth'

const mockAuth = auth as unknown as Mock

const CLIENT_SESSION  = { user: { id: 'client-1', role: 'CLIENT' }, expires: '2099-01-01' }
const MOCK_ORDER      = { id: 'ord-1', clientId: 'client-1', labId: 'lab-1', status: 'QUOTE_REQUESTED' }
const MOCK_ATTACHMENT = { id: 'att-1', r2Key: 'orders/ord-1/x.pdf' }

function makeFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData()
  fd.append('orderId',  overrides.orderId  ?? 'ord-1')
  fd.append('fileName', overrides.fileName ?? 'spec.pdf')
  fd.append('mimeType', overrides.mimeType ?? 'application/pdf')
  fd.append('fileSize', overrides.fileSize ?? '1024')
  return fd
}

describe('requestSpecUploadUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.generatePresignedPutUrl.mockResolvedValue('https://mock-r2.example.com/presigned')
    mocks.attachmentCreate.mockResolvedValue(MOCK_ATTACHMENT)
    mocks.orderFindUnique.mockResolvedValue(MOCK_ORDER)
  })

  it('returns Unauthorized for non-CLIENT role, prisma not called', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'LAB_ADMIN' }, expires: '2099-01-01' })
    const result = await requestSpecUploadUrl(null, makeFormData())
    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.orderFindUnique).not.toHaveBeenCalled()
    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
  })

  it('returns Unauthorized when session is absent', async () => {
    mockAuth.mockResolvedValue(null)
    const result = await requestSpecUploadUrl(null, makeFormData())
    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.orderFindUnique).not.toHaveBeenCalled()
  })

  it('returns error when order not found, attachment.create not called', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.orderFindUnique.mockResolvedValue(null)
    const result = await requestSpecUploadUrl(null, makeFormData())
    expect(result).toEqual({ message: 'Order not found.' })
    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
  })

  it('returns Unauthorized when order belongs to different client', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    mocks.orderFindUnique.mockResolvedValue({ ...MOCK_ORDER, clientId: 'other-client' })
    const result = await requestSpecUploadUrl(null, makeFormData())
    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
  })

  it('returns error for disallowed MIME type without DB write', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    const result = await requestSpecUploadUrl(null, makeFormData({ mimeType: 'application/x-msdownload' }))
    expect(result).toHaveProperty('message')
    expect((result as { message: string }).message).toMatch(/unsupported/i)
    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
  })

  it('returns error for oversize file without DB write', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    const result = await requestSpecUploadUrl(null, makeFormData({ fileSize: String(21 * 1024 * 1024) }))
    expect(result).toHaveProperty('message')
    expect((result as { message: string }).message).toMatch(/20 MB/i)
    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
  })

  it('happy path: attachment.create called BEFORE generatePresignedPutUrl; returns presignedUrl, r2Key, attachmentId', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    const callOrder: string[] = []
    mocks.attachmentCreate.mockImplementation(async () => { callOrder.push('create'); return MOCK_ATTACHMENT })
    mocks.generatePresignedPutUrl.mockImplementation(async () => { callOrder.push('presign'); return 'https://mock-r2.example.com/presigned' })

    const result = await requestSpecUploadUrl(null, makeFormData())

    expect(callOrder).toEqual(['create', 'presign'])
    expect(result).toMatchObject({ presignedUrl: 'https://mock-r2.example.com/presigned', attachmentId: MOCK_ATTACHMENT.id })
    const r2Key = (result as { r2Key: string }).r2Key
    expect(r2Key).toMatch(/^orders\/ord-1\//)
  })

  it('attachment.create uses attachmentType SPECIFICATION and orders/ r2Key prefix', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    await requestSpecUploadUrl(null, makeFormData())
    expect(mocks.attachmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attachmentType: 'SPECIFICATION',
          orderId:        'ord-1',
          labId:          'lab-1',
        }),
      }),
    )
    const createArg = mocks.attachmentCreate.mock.calls[0][0]
    expect(createArg.data.r2Key).toMatch(/^orders\/ord-1\//)
  })

  it('R2ValidationError from presigning returns friendly message; orphan row kept (not deleted)', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    const { R2ValidationError } = await import('@/lib/storage/r2')
    mocks.generatePresignedPutUrl.mockRejectedValue(new R2ValidationError('bad key'))
    const result = await requestSpecUploadUrl(null, makeFormData())
    expect(result).toHaveProperty('message')
    expect(mocks.attachmentCreate).toHaveBeenCalledTimes(1)
  })

  it('R2ConfigError from presigning returns storage unavailable message', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    const { R2ConfigError } = await import('@/lib/storage/r2')
    mocks.generatePresignedPutUrl.mockRejectedValue(new R2ConfigError('missing env'))
    const result = await requestSpecUploadUrl(null, makeFormData())
    expect(result).toEqual({ message: 'Storage unavailable. Try again later.' })
    expect(mocks.attachmentCreate).toHaveBeenCalledTimes(1)
  })

  it('generatePresignedPutUrl called with allowedPrefix orders/ and maxBytes MAX_BYTES', async () => {
    mockAuth.mockResolvedValue(CLIENT_SESSION)
    await requestSpecUploadUrl(null, makeFormData())
    expect(mocks.generatePresignedPutUrl).toHaveBeenCalledWith(
      expect.stringMatching(/^orders\//),
      'application/pdf',
      1024,
      { allowedPrefix: 'orders/', maxBytes: 20 * 1024 * 1024 },
    )
  })

  describe('SPEC_UPLOADABLE_STATUSES status window', () => {
    it('accepts an IN_PROGRESS order', async () => {
      mockAuth.mockResolvedValue(CLIENT_SESSION)
      mocks.orderFindUnique.mockResolvedValue({ ...MOCK_ORDER, status: 'IN_PROGRESS' })
      const result = await requestSpecUploadUrl(null, makeFormData())
      expect(result).toMatchObject({ presignedUrl: 'https://mock-r2.example.com/presigned' })
      expect(mocks.attachmentCreate).toHaveBeenCalledTimes(1)
    })

    it.each([
      'COMPLETED',
      'CANCELLED',
      'QUOTE_REJECTED',
      'REFUND_PENDING',
      'REFUNDED',
    ])('rejects status %s with no attachment.create call', async (status) => {
      mockAuth.mockResolvedValue(CLIENT_SESSION)
      mocks.orderFindUnique.mockResolvedValue({ ...MOCK_ORDER, status })
      const result = await requestSpecUploadUrl(null, makeFormData())
      expect(result).toEqual({ message: 'Order is not accepting specifications.' })
      expect(mocks.attachmentCreate).not.toHaveBeenCalled()
    })
  })
})
