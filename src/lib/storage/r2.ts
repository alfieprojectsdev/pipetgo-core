import 'server-only'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { ALLOWED_MIME_TYPES, MAX_BYTES, MAX_RESULT_BYTES } from './constants'

export { ALLOWED_MIME_TYPES, MAX_BYTES, MAX_RESULT_BYTES }

export class R2ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'R2ConfigError'
  }
}

export class R2ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'R2ValidationError'
  }
}

type R2Config = {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucketName: string
  endpoint: string
}

function getR2Config(): R2Config {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const bucketName = process.env.R2_BUCKET_NAME
  const endpoint = process.env.R2_ENDPOINT

  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !endpoint) {
    throw new R2ConfigError(
      'R2 config incomplete — CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_ENDPOINT must all be set',
    )
  }

  return { accountId, accessKeyId, secretAccessKey, bucketName, endpoint }
}

function buildS3Client(config: R2Config): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    requestHandler: { requestTimeout: 10_000 },
  })
}

function validateMime(contentType: string): void {
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(contentType)) {
    throw new R2ValidationError(
      `Unsupported MIME type: ${contentType}. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`,
    )
  }
}

// ALLOWED_PREFIXES enumerates the R2 key namespaces this module is authorized to access.
// The prefix guard in generatePresignedPutUrl/GetUrl performs a startsWith(allowedPrefix)
// check where allowedPrefix must be a member of this set — no wildcards or arrays accepted.
// Adding a new prefix here is intentional; a typo that widens the allowed namespace is a
// security regression. (ref: DL-004, R-001)
const ALLOWED_PREFIXES = ['labs/', 'orders/'] as const
type AllowedPrefix = typeof ALLOWED_PREFIXES[number]

function validatePrefix(key: string, allowedPrefix: AllowedPrefix): void {
  if (!key.startsWith(allowedPrefix)) {
    throw new R2ValidationError(`Key must start with '${allowedPrefix}' prefix: ${key}`)
  }
}

// validateSize rejects files that exceed maxBytes or carry an invalid/zero size.
// The caller supplies maxBytes (MAX_BYTES for SPECIFICATION/KYC, MAX_RESULT_BYTES for RESULT)
// so the guard enforces the per-type limit at the storage layer — consistent with the
// action-level check. (ref: DL-005, R-004)
function validateSize(contentLength: number, maxBytes: number): void {
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    throw new R2ValidationError(`Invalid file size: ${contentLength}`)
  }
  if (contentLength > maxBytes) {
    throw new R2ValidationError(
      `File size ${contentLength} exceeds maximum ${maxBytes} bytes`,
    )
  }
}

export async function generatePresignedPutUrl(
  key: string,
  contentType: string,
  contentLength: number,
  options?: { allowedPrefix?: AllowedPrefix; maxBytes?: number },
): Promise<string> {
  const allowedPrefix: AllowedPrefix = options?.allowedPrefix ?? 'labs/'
  validatePrefix(key, allowedPrefix)
  validateMime(contentType)
  validateSize(contentLength, options?.maxBytes ?? MAX_BYTES)

  const config = getR2Config()
  const client = buildS3Client(config)

  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: config.bucketName,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    }),
    { expiresIn: 300 },
  )
}

/**
 * Mints a 300s presigned GET URL for an R2 object.
 * Key must start with the given allowedPrefix — throws R2ValidationError otherwise.
 * Call from a Server Action only; the key must be loaded from a stored row (LabDocument.r2Key
 * or Attachment.r2Key), never from client input. (ref: DL-004, DL-010)
 */
export async function generatePresignedGetUrl(
  key: string,
  options?: { allowedPrefix?: AllowedPrefix },
): Promise<string> {
  const allowedPrefix: AllowedPrefix = options?.allowedPrefix ?? 'labs/'
  validatePrefix(key, allowedPrefix)

  const config = getR2Config()
  const client = buildS3Client(config)

  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: config.bucketName,
      Key: key,
    }),
    { expiresIn: 300 },
  )
}
