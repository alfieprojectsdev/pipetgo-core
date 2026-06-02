// Tests for requestResultUploadUrl: covers LAB_ADMIN role gate, ownerId guard,
// IN_PROGRESS-only status window, PDF-only MIME rejection, and 50 MB ceiling. (ref: DL-003, DL-005, DL-007)

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

import { requestResultUploadUrl } from '../upload-action'
import { auth } from '@/lib/auth'

const mockAuth = auth as unknown as Mock

const LAB_ADMIN_SESSION = { user: { id: 'lab-owner-1', role: 'LAB_ADMIN' }, expires: '2099-01-01' }
const MOCK_ORDER = {
  id:     'ord-1',
  labId:  'lab-1',
  status: 'IN_PROGRESS',
  lab:    { ownerId: 'lab-owner-1' },
}
const MOCK_ATTACHMENT = { id: 'att-1', r2Key: 'orders/ord-1/result.pdf' }

function makeFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData()
  fd.append('orderId',  overrides.orderId  ?? 'ord-1')
  fd.append('fileName', overrides.fileName ?? 'result.pdf')
  fd.append('mimeType', overrides.mimeType ?? 'application/pdf')
  fd.append('fileSize', overrides.fileSize ?? '1024')
  return fd
}

describe('requestResultUploadUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.generatePresignedPutUrl.mockResolvedValue('https://mock-r2.example.com/presigned')
    mocks.attachmentCreate.mockResolvedValue(MOCK_ATTACHMENT)
    mocks.orderFindUnique.mockResolvedValue(MOCK_ORDER)
  })

  it('returns Unauthorized for non-LAB_ADMIN role, prisma not called', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'CLIENT' }, expires: '2099-01-01' })
    const result = await requestResultUploadUrl(null, makeFormData())
    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.orderFindUnique).not.toHaveBeenCalled()
    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
  })

  it('returns Unauthorized when session is absent', async () => {
    mockAuth.mockResolvedValue(null)
    const result = await requestResultUploadUrl(null, makeFormData())
    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.orderFindUnique).not.toHaveBeenCalled()
  })

  it('returns error when order not found, attachment.create not called', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.orderFindUnique.mockResolvedValue(null)
    const result = await requestResultUploadUrl(null, makeFormData())
    expect(result).toEqual({ message: 'Order not found.' })
    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
  })

  it('returns Unauthorized when order belongs to different lab owner', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.orderFindUnique.mockResolvedValue({ ...MOCK_ORDER, lab: { ownerId: 'other-owner' } })
    const result = await requestResultUploadUrl(null, makeFormData())
    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
  })

  it('throws when order.lab is null after explicit select — referential integrity violation', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.orderFindUnique.mockResolvedValue({ ...MOCK_ORDER, lab: null })
    await expect(requestResultUploadUrl(null, makeFormData())).rejects.toThrow(/referential integrity violation/)
  })

  it('returns error when order status is ACKNOWLEDGED — StatusWin: IN_PROGRESS only', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.orderFindUnique.mockResolvedValue({ ...MOCK_ORDER, status: 'ACKNOWLEDGED' })
    const result = await requestResultUploadUrl(null, makeFormData())
    expect(result).toHaveProperty('message')
    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
  })

  it('returns error when order status is COMPLETED — StatusWin: IN_PROGRESS only', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.orderFindUnique.mockResolvedValue({ ...MOCK_ORDER, status: 'COMPLETED' })
    const result = await requestResultUploadUrl(null, makeFormData())
    expect(result).toHaveProperty('message')
    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
  })

  it('returns error for non-PDF MIME type without DB write', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    const result = await requestResultUploadUrl(null, makeFormData({ mimeType: 'image/jpeg' }))
    expect(result).toHaveProperty('message')
    expect((result as { message: string }).message).toMatch(/PDF/i)
    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
  })

  it('returns error for file exceeding 50 MB without DB write', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    const result = await requestResultUploadUrl(null, makeFormData({ fileSize: String(51 * 1024 * 1024) }))
    expect(result).toHaveProperty('message')
    expect((result as { message: string }).message).toMatch(/50 MB/i)
    expect(mocks.attachmentCreate).not.toHaveBeenCalled()
  })

  it('accepts file at exactly 50 MB', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    const result = await requestResultUploadUrl(null, makeFormData({ fileSize: String(50 * 1024 * 1024) }))
    expect(result).toMatchObject({ presignedUrl: 'https://mock-r2.example.com/presigned' })
  })

  it('happy path: attachment.create called BEFORE generatePresignedPutUrl; returns presignedUrl, r2Key, attachmentId', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    const callOrder: string[] = []
    mocks.attachmentCreate.mockImplementation(async () => { callOrder.push('create'); return MOCK_ATTACHMENT })
    mocks.generatePresignedPutUrl.mockImplementation(async () => { callOrder.push('presign'); return 'https://mock-r2.example.com/presigned' })

    const result = await requestResultUploadUrl(null, makeFormData())

    expect(callOrder).toEqual(['create', 'presign'])
    expect(result).toMatchObject({ presignedUrl: 'https://mock-r2.example.com/presigned', attachmentId: MOCK_ATTACHMENT.id })
    const r2Key = (result as { r2Key: string }).r2Key
    expect(r2Key).toMatch(/^orders\/ord-1\//)
  })

  it('attachment.create uses attachmentType RESULT and orders/ r2Key prefix', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    await requestResultUploadUrl(null, makeFormData())
    expect(mocks.attachmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attachmentType: 'RESULT',
          orderId: 'ord-1',
          labId:   'lab-1',
        }),
      }),
    )
    const createArg = mocks.attachmentCreate.mock.calls[0][0]
    expect(createArg.data.r2Key).toMatch(/^orders\/ord-1\//)
  })

  it('R2ConfigError from presigning returns storage unavailable message', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    const { R2ConfigError } = await import('@/lib/storage/r2')
    mocks.generatePresignedPutUrl.mockRejectedValue(new R2ConfigError('missing env'))
    const result = await requestResultUploadUrl(null, makeFormData())
    expect(result).toEqual({ message: 'Storage unavailable. Try again later.' })
    expect(mocks.attachmentCreate).toHaveBeenCalledTimes(1)
  })

  it('generatePresignedPutUrl called with allowedPrefix orders/ and maxBytes MAX_RESULT_BYTES', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    await requestResultUploadUrl(null, makeFormData())
    expect(mocks.generatePresignedPutUrl).toHaveBeenCalledWith(
      expect.stringMatching(/^orders\//),
      'application/pdf',
      1024,
      { allowedPrefix: 'orders/', maxBytes: 50 * 1024 * 1024 },
    )
  })
})
