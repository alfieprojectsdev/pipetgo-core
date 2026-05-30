import 'server-only'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { ALLOWED_MIME_TYPES, MAX_BYTES } from './constants'

export { ALLOWED_MIME_TYPES, MAX_BYTES }

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

function validateSize(contentLength: number): void {
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    throw new R2ValidationError(`Invalid file size: ${contentLength}`)
  }
  if (contentLength > MAX_BYTES) {
    throw new R2ValidationError(
      `File size ${contentLength} exceeds maximum ${MAX_BYTES} bytes (20 MB)`,
    )
  }
}

export async function generatePresignedPutUrl(
  key: string,
  contentType: string,
  contentLength: number,
): Promise<string> {
  if (!key.startsWith('labs/')) {
    throw new R2ValidationError(`Key must start with 'labs/' prefix: ${key}`)
  }
  validateMime(contentType)
  validateSize(contentLength)

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
 * Key must start with 'labs/' — throws R2ValidationError otherwise (defense-in-depth
 * against arbitrary-key requests, reusing the same prefix guard as the PUT path).
 * Call from a Server Action only; the key must be loaded from a stored LabDocument.r2Key,
 * never from client input. (ref: DL-004)
 */
export async function generatePresignedGetUrl(
  key: string,
): Promise<string> {
  if (!key.startsWith('labs/')) {
    throw new R2ValidationError(`Key must start with 'labs/' prefix: ${key}`)
  }

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
