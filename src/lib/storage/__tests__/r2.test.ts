import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetSignedUrl = vi.fn().mockResolvedValue('https://mock-r2.example.com/mock-url')

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn().mockImplementation(() => ({})),
  PutObjectCommand: vi.fn().mockImplementation((params) => params),
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

  it('module exports generatePresignedPutUrl but NOT generatePresignedGetUrl', async () => {
    const r2Module = await import('@/lib/storage/r2')
    expect(typeof r2Module.generatePresignedPutUrl).toBe('function')
    expect((r2Module as Record<string, unknown>)['generatePresignedGetUrl']).toBeUndefined()
  })

  it('module exports ALLOWED_MIME_TYPES and MAX_BYTES', async () => {
    const { ALLOWED_MIME_TYPES, MAX_BYTES } = await import('@/lib/storage/r2')
    expect(ALLOWED_MIME_TYPES).toContain('application/pdf')
    expect(MAX_BYTES).toBe(20 * 1024 * 1024)
  })
})
