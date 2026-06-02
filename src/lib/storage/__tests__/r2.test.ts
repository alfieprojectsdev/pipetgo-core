// Tests cover the parameterized prefix guard and per-type size limit for both
// labs/ (KYC/accreditation) and orders/ (attachment) key namespaces.
// Each test isolates a specific guard boundary — prefix mismatch, size boundary,
// MIME rejection — rather than testing the full presign flow end-to-end. (ref: DL-004, DL-005)
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetSignedUrl = vi.fn().mockResolvedValue('https://mock-r2.example.com/mock-url')

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({})),
  PutObjectCommand: vi.fn().mockImplementation((params) => params),
  GetObjectCommand: vi.fn().mockImplementation((params) => params),
}))

describe('r2 storage client', () => {
  beforeEach(() => {
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'test-account-id')
    vi.stubEnv('R2_ACCESS_KEY_ID', 'test-access-key')
    vi.stubEnv('R2_SECRET_ACCESS_KEY', 'test-secret-key')
    vi.stubEnv('R2_BUCKET_NAME', 'test-bucket')
    vi.stubEnv('R2_ENDPOINT', 'https://test-account-id.r2.cloudflarestorage.com')
    mockGetSignedUrl.mockClear()
  })

  it('returns a URL for valid inputs', async () => {
    const { generatePresignedPutUrl } = await import('@/lib/storage/r2')
    const url = await generatePresignedPutUrl('labs/L1/x.pdf', 'application/pdf', 1024)
    expect(url).toBe('https://mock-r2.example.com/mock-url')
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1)
  })

  it('throws R2ValidationError for disallowed MIME type', async () => {
    const { generatePresignedPutUrl, R2ValidationError } = await import('@/lib/storage/r2')
    await expect(
      generatePresignedPutUrl('labs/L1/x.exe', 'application/x-msdownload', 1024),
    ).rejects.toBeInstanceOf(R2ValidationError)
    expect(mockGetSignedUrl).not.toHaveBeenCalled()
  })

  it('throws R2ValidationError for oversize file', async () => {
    const { generatePresignedPutUrl, R2ValidationError } = await import('@/lib/storage/r2')
    await expect(
      generatePresignedPutUrl('labs/L1/x.pdf', 'application/pdf', 21 * 1024 * 1024),
    ).rejects.toBeInstanceOf(R2ValidationError)
  })

  it('throws R2ValidationError for key without labs/ prefix', async () => {
    const { generatePresignedPutUrl, R2ValidationError } = await import('@/lib/storage/r2')
    await expect(
      generatePresignedPutUrl('uploads/x.pdf', 'application/pdf', 1024),
    ).rejects.toBeInstanceOf(R2ValidationError)
  })

  it('throws R2ConfigError when env vars are absent', async () => {
    vi.unstubAllEnvs()
    const { generatePresignedPutUrl, R2ConfigError } = await import('@/lib/storage/r2')
    await expect(
      generatePresignedPutUrl('labs/L1/x.pdf', 'application/pdf', 1024),
    ).rejects.toBeInstanceOf(R2ConfigError)
  })

  it('module exports generatePresignedPutUrl AND generatePresignedGetUrl', async () => {
    // Both presign functions are exported: generatePresignedPutUrl for lab uploads,
    // generatePresignedGetUrl for admin document viewing. The test validates both
    // are present so a future removal of either fails loudly here.
    const r2Module = await import('@/lib/storage/r2')
    expect(typeof r2Module.generatePresignedPutUrl).toBe('function')
    expect(typeof (r2Module as Record<string, unknown>)['generatePresignedGetUrl']).toBe('function')
  })

  it('module exports ALLOWED_MIME_TYPES and MAX_BYTES', async () => {
    const { ALLOWED_MIME_TYPES, MAX_BYTES } = await import('@/lib/storage/r2')
    expect(ALLOWED_MIME_TYPES).toContain('application/pdf')
    expect(MAX_BYTES).toBe(20 * 1024 * 1024)
  })

  it('module exports MAX_RESULT_BYTES as 50 MB', async () => {
    const { MAX_RESULT_BYTES } = await import('@/lib/storage/r2')
    expect(MAX_RESULT_BYTES).toBe(50 * 1024 * 1024)
  })

  describe('generatePresignedGetUrl', () => {
    it('returns a presigned GET URL for a labs/-prefixed key', async () => {
      const { generatePresignedGetUrl } = await import('@/lib/storage/r2')
      const url = await generatePresignedGetUrl('labs/L1/doc.pdf')
      expect(url).toBe('https://mock-r2.example.com/mock-url')
      expect(mockGetSignedUrl).toHaveBeenCalledTimes(1)
      const [, cmd, opts] = mockGetSignedUrl.mock.calls[0]
      expect(cmd).toMatchObject({ Key: 'labs/L1/doc.pdf' })
      expect(opts).toMatchObject({ expiresIn: 300 })
    })

    it('throws R2ValidationError for a key without labs/ prefix', async () => {
      const { generatePresignedGetUrl, R2ValidationError } = await import('@/lib/storage/r2')
      await expect(
        generatePresignedGetUrl('uploads/x.pdf'),
      ).rejects.toBeInstanceOf(R2ValidationError)
      expect(mockGetSignedUrl).not.toHaveBeenCalled()
    })

    it('passes expiresIn 300 to getSignedUrl', async () => {
      const { generatePresignedGetUrl } = await import('@/lib/storage/r2')
      await generatePresignedGetUrl('labs/L1/doc.pdf')
      const [, , opts] = mockGetSignedUrl.mock.calls[0]
      expect(opts.expiresIn).toBe(300)
    })

    it('accepts orders/ prefix when allowedPrefix is orders/', async () => {
      const { generatePresignedGetUrl } = await import('@/lib/storage/r2')
      await expect(
        generatePresignedGetUrl('orders/ord-1/doc.pdf', { allowedPrefix: 'orders/' }),
      ).resolves.toBe('https://mock-r2.example.com/mock-url')
    })

    it('rejects labs/ key when allowedPrefix is orders/', async () => {
      const { generatePresignedGetUrl, R2ValidationError } = await import('@/lib/storage/r2')
      await expect(
        generatePresignedGetUrl('labs/lab-1/doc.pdf', { allowedPrefix: 'orders/' }),
      ).rejects.toBeInstanceOf(R2ValidationError)
    })
  })

  describe('generatePresignedPutUrl — prefix + size options', () => {
    it('accepts orders/ prefix key when allowedPrefix is orders/', async () => {
      const { generatePresignedPutUrl } = await import('@/lib/storage/r2')
      await expect(
        generatePresignedPutUrl('orders/ord-1/x.pdf', 'application/pdf', 1024, { allowedPrefix: 'orders/' }),
      ).resolves.toBe('https://mock-r2.example.com/mock-url')
    })

    it('rejects labs/ key when allowedPrefix is orders/', async () => {
      const { generatePresignedPutUrl, R2ValidationError } = await import('@/lib/storage/r2')
      await expect(
        generatePresignedPutUrl('labs/lab-1/x.pdf', 'application/pdf', 1024, { allowedPrefix: 'orders/' }),
      ).rejects.toBeInstanceOf(R2ValidationError)
    })

    it('accepts file up to MAX_RESULT_BYTES when maxBytes is MAX_RESULT_BYTES', async () => {
      const { generatePresignedPutUrl, MAX_RESULT_BYTES } = await import('@/lib/storage/r2')
      await expect(
        generatePresignedPutUrl('orders/ord-1/result.pdf', 'application/pdf', MAX_RESULT_BYTES, { allowedPrefix: 'orders/', maxBytes: MAX_RESULT_BYTES }),
      ).resolves.toBe('https://mock-r2.example.com/mock-url')
    })

    it('rejects file exceeding MAX_RESULT_BYTES', async () => {
      const { generatePresignedPutUrl, R2ValidationError, MAX_RESULT_BYTES } = await import('@/lib/storage/r2')
      await expect(
        generatePresignedPutUrl('orders/ord-1/result.pdf', 'application/pdf', MAX_RESULT_BYTES + 1, { allowedPrefix: 'orders/', maxBytes: MAX_RESULT_BYTES }),
      ).rejects.toBeInstanceOf(R2ValidationError)
    })
  })
})
