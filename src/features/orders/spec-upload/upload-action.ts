/**
 * Server Action: requestSpecUploadUrl
 *
 * Step 1 of the two-step SPECIFICATION upload flow for CLIENT users.
 * Validates the file metadata, re-checks CLIENT role and order ownership (TOCTOU),
 * enforces the SPECIFICATION status window, and returns a presigned R2 PUT URL
 * bound to the server-generated r2Key. The Attachment row is created PRE-presign
 * so the attachmentId is available to the confirm step. (ref: DL-002, DL-007)
 *
 * EXT_BY_MIME: `as const satisfies` so a missing MIME entry is a compile-time error,
 * never a silent undefined ext. (ref: DL-006)
 */
'use server'

import { createId } from '@paralleldrive/cuid2'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { generatePresignedPutUrl, R2ValidationError, R2ConfigError } from '@/lib/storage/r2'
import { ALLOWED_MIME_TYPES, MAX_BYTES } from '@/lib/storage/constants'

type ActionState = { message?: string } | null

const SPEC_UPLOADABLE_STATUSES = new Set([
  'QUOTE_REQUESTED',
  'QUOTE_PROVIDED',
  'PENDING',
  'PAYMENT_PENDING',
  'PAYMENT_FAILED',
  'ACKNOWLEDGED',
  'IN_PROGRESS',
] as const)

const EXT_BY_MIME = {
  'application/pdf': 'pdf',
  'image/jpeg':      'jpg',
  'image/png':       'png',
} as const satisfies Record<typeof ALLOWED_MIME_TYPES[number], string>

export async function requestSpecUploadUrl(
  _prev: ActionState | { presignedUrl: string; r2Key: string; attachmentId: string },
  formData: FormData,
): Promise<ActionState | { presignedUrl: string; r2Key: string; attachmentId: string }> {
  const fileNameValue  = formData.get('fileName')
  const mimeTypeValue  = formData.get('mimeType')
  const fileSizeRaw    = formData.get('fileSize')
  const orderIdValue   = formData.get('orderId')

  const fileName    = typeof fileNameValue  === 'string' ? fileNameValue  : null
  const mimeType    = typeof mimeTypeValue  === 'string' ? mimeTypeValue  : null
  const fileSizeStr = typeof fileSizeRaw    === 'string' ? fileSizeRaw    : null
  const orderId     = typeof orderIdValue   === 'string' ? orderIdValue   : null

  if (!fileName || !mimeType || !fileSizeStr || !orderId) {
    return { message: 'Missing field.' }
  }

  const fileSize = Number(fileSizeStr)
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return { message: 'Invalid file size.' }
  }

  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
    return { message: 'Unauthorized.' }
  }

  const order = await prisma.order.findUnique({
    where:  { id: orderId },
    select: { id: true, clientId: true, labId: true, status: true },
  })
  if (!order) return { message: 'Order not found.' }
  if (order.clientId !== session.user.id) return { message: 'Unauthorized.' }
  if (!(SPEC_UPLOADABLE_STATUSES as ReadonlySet<string>).has(order.status)) {
    return { message: 'Order is not accepting specifications.' }
  }

  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return { message: 'Unsupported file type. Allowed: PDF, JPEG, PNG.' }
  }
  if (fileSize > MAX_BYTES) {
    return { message: 'File exceeds 20 MB limit.' }
  }

  const ext   = EXT_BY_MIME[mimeType as typeof ALLOWED_MIME_TYPES[number]]
  const r2Key = `orders/${order.id}/${createId()}.${ext}`

  const attachment = await prisma.attachment.create({
    data: {
      orderId:        order.id,
      labId:          order.labId,
      uploadedById:   session.user.id,
      attachmentType: 'SPECIFICATION',
      fileName,
      r2Key,
      fileSize,
      mimeType,
    },
  })

  try {
    const presignedUrl = await generatePresignedPutUrl(
      r2Key,
      mimeType,
      fileSize,
      { allowedPrefix: 'orders/', maxBytes: MAX_BYTES },
    )
    return { presignedUrl, r2Key, attachmentId: attachment.id }
  } catch (err) {
    if (err instanceof R2ValidationError || err instanceof R2ConfigError) {
      return { message: 'Storage unavailable. Try again later.' }
    }
    throw err
  }
}
