/**
 * Unit tests for requestUploadUrl server action.
 * Uses full Prisma mock and r2 storage mock.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

const mocks = vi.hoisted(() => ({
  labFindUnique: vi.fn(),
  labDocumentCreate: vi.fn(),
  auth: vi.fn(),
  generatePresignedPutUrl: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    lab: { findUnique: mocks.labFindUnique },
    labDocument: { create: mocks.labDocumentCreate },
  },
}))

vi.mock('@/lib/auth', () => ({
  auth: mocks.auth,
}))

vi.mock('@/lib/storage/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/storage/r2')>()
  return {
    ...actual,
    generatePresignedPutUrl: mocks.generatePresignedPutUrl,
  }
})

import { requestUploadUrl } from '../upload-action'
import { auth } from '@/lib/auth'

const mockAuth = auth as unknown as Mock

const LAB_ADMIN_SESSION = {
  user: { id: 'user-lab-1', role: 'LAB_ADMIN' },
  expires: '2099-01-01',
}

const MOCK_LAB = { id: 'lab-1', ownerId: 'user-lab-1' }
const MOCK_DOC = { id: 'doc-1', labId: 'lab-1', r2Key: 'labs/lab-1/abc.pdf' }

function makeFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData()
  fd.append('fileName', overrides.fileName ?? 'test.pdf')
  fd.append('mimeType', overrides.mimeType ?? 'application/pdf')
  fd.append('fileSize', overrides.fileSize ?? '1024')
  fd.append('documentType', overrides.documentType ?? 'BIR_2303')
  return fd
}

describe('requestUploadUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.generatePresignedPutUrl.mockResolvedValue('https://mock-r2.example.com/presigned')
    mocks.labDocumentCreate.mockResolvedValue(MOCK_DOC)
  })

  it('returns Unauthorized for non-LAB_ADMIN role, prisma not called', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'CLIENT' }, expires: '2099-01-01' })

    const result = await requestUploadUrl(null, makeFormData())

    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.labFindUnique).not.toHaveBeenCalled()
    expect(mocks.labDocumentCreate).not.toHaveBeenCalled()
  })

  it('returns Unauthorized when session is absent, prisma not called', async () => {
    mockAuth.mockResolvedValue(null)

    const result = await requestUploadUrl(null, makeFormData())

    expect(result).toEqual({ message: 'Unauthorized.' })
    expect(mocks.labFindUnique).not.toHaveBeenCalled()
  })

  it('returns error when lab not found, labDocument.create not called', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.labFindUnique.mockResolvedValue(null)

    const result = await requestUploadUrl(null, makeFormData())

    expect(result).toEqual({ message: 'No lab found for user.' })
    expect(mocks.labDocumentCreate).not.toHaveBeenCalled()
  })

  it('returns error for disallowed MIME type without DB write', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.labFindUnique.mockResolvedValue(MOCK_LAB)

    const result = await requestUploadUrl(null, makeFormData({ mimeType: 'application/x-msdownload' }))

    expect(result).toHaveProperty('message')
    expect((result as { message: string }).message).toMatch(/unsupported/i)
    expect(mocks.labDocumentCreate).not.toHaveBeenCalled()
  })

  it('returns error for oversize file without DB write', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.labFindUnique.mockResolvedValue(MOCK_LAB)

    const result = await requestUploadUrl(null, makeFormData({ fileSize: String(21 * 1024 * 1024) }))

    expect(result).toHaveProperty('message')
    expect((result as { message: string }).message).toMatch(/20 MB/i)
    expect(mocks.labDocumentCreate).not.toHaveBeenCalled()
  })

  it('throws for unknown documentType (unhandled-branch discipline)', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.labFindUnique.mockResolvedValue(MOCK_LAB)

    await expect(
      requestUploadUrl(null, makeFormData({ documentType: 'UNKNOWN_TYPE' })),
    ).rejects.toThrow('Unknown documentType: UNKNOWN_TYPE')
  })

  it('happy path: labDocument.create called BEFORE generatePresignedPutUrl; returns presignedUrl, r2Key, labDocumentId', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.labFindUnique.mockResolvedValue(MOCK_LAB)

    const callOrder: string[] = []
    mocks.labDocumentCreate.mockImplementation(async () => {
      callOrder.push('create')
      return MOCK_DOC
    })
    mocks.generatePresignedPutUrl.mockImplementation(async () => {
      callOrder.push('presign')
      return 'https://mock-r2.example.com/presigned'
    })

    const result = await requestUploadUrl(null, makeFormData())

    expect(callOrder).toEqual(['create', 'presign'])
    expect(result).toMatchObject({
      presignedUrl: 'https://mock-r2.example.com/presigned',
      labDocumentId: MOCK_DOC.id,
    })
    const r2Key = (result as { r2Key: string }).r2Key
    expect(r2Key).toMatch(/^labs\/lab-1\//)
  })

  it('R2ValidationError from presigning returns error message, does NOT delete the orphan row', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.labFindUnique.mockResolvedValue(MOCK_LAB)
    mocks.labDocumentCreate.mockResolvedValue(MOCK_DOC)

    const { R2ValidationError } = await import('@/lib/storage/r2')
    mocks.generatePresignedPutUrl.mockRejectedValue(new R2ValidationError('bad key'))

    const result = await requestUploadUrl(null, makeFormData())

    expect(result).toHaveProperty('message')
    expect(mocks.labDocumentCreate).toHaveBeenCalledTimes(1)
  })

  it('R2ConfigError from presigning returns error message, does NOT delete the orphan row', async () => {
    mockAuth.mockResolvedValue(LAB_ADMIN_SESSION)
    mocks.labFindUnique.mockResolvedValue(MOCK_LAB)
    mocks.labDocumentCreate.mockResolvedValue(MOCK_DOC)

    const { R2ConfigError } = await import('@/lib/storage/r2')
    mocks.generatePresignedPutUrl.mockRejectedValue(new R2ConfigError('missing env'))

    const result = await requestUploadUrl(null, makeFormData())

    expect(result).toEqual({ message: 'Storage unavailable. Try again later.' })
    expect(mocks.labDocumentCreate).toHaveBeenCalledTimes(1)
  })
})
