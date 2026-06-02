/**
 * Server Action: requestResultUploadUrl
 *
 * Step 1 of the two-step RESULT upload flow for LAB_ADMIN users.
 * Validates file metadata, re-checks LAB_ADMIN role and lab ownership via
 * order.lab.ownerId (TOCTOU), enforces the RESULT status window (IN_PROGRESS only),
 * and returns a presigned R2 PUT URL for a RESULT attachment. (ref: DL-003, DL-007)
 *
 * RESULT_MIME_TYPES: PDF-only — RESULT documents carry ITA result-integrity liability
 * and are formal deliverables, not reference docs. (ref: DL-006)
 *
 * Size limit: MAX_RESULT_BYTES (50 MB), threaded through both this action-level check
 * and the r2.ts validateSize guard so both layers agree. (ref: DL-005, R-004)
 */
'use server'

import { createId } from '@paralleldrive/cuid2'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { generatePresignedPutUrl, R2ValidationError, R2ConfigError } from '@/lib/storage/r2'
import { MAX_RESULT_BYTES } from '@/lib/storage/constants'

type ActionState = { message?: string } | null

const RESULT_MIME_TYPES = ['application/pdf'] as const
type ResultMimeType = typeof RESULT_MIME_TYPES[number]

const EXT_BY_MIME = {
  'application/pdf': 'pdf',
} as const satisfies Record<ResultMimeType, string>

export async function requestResultUploadUrl(
  _prev: ActionState | { presignedUrl: string; r2Key: string; attachmentId: string },
  formData: FormData,
): Promise<ActionState | { presignedUrl: string; r2Key: string; attachmentId: string }> {
  const fileNameValue = formData.get('fileName')
  const mimeTypeValue = formData.get('mimeType')
  const fileSizeRaw   = formData.get('fileSize')
  const orderIdValue  = formData.get('orderId')

  const fileName    = typeof fileNameValue === 'string' ? fileNameValue : null
  const mimeType    = typeof mimeTypeValue === 'string' ? mimeTypeValue : null
  const fileSizeStr = typeof fileSizeRaw   === 'string' ? fileSizeRaw   : null
  const orderId     = typeof orderIdValue  === 'string' ? orderIdValue  : null

  if (!fileName || !mimeType || !fileSizeStr || !orderId) {
    return { message: 'Missing field.' }
  }

  const fileSize = Number(fileSizeStr)
  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return { message: 'Invalid file size.' }
  }

  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
    return { message: 'Unauthorized.' }
  }

  const order = await prisma.order.findUnique({
    where:  { id: orderId },
    select: { id: true, labId: true, status: true, lab: { select: { ownerId: true } } },
  })
  if (!order) return { message: 'Order not found.' }
  if (!order.lab) {
    throw new Error(`Order ${orderId} missing lab after explicit include — referential integrity violation`)
  }
  if (order.lab.ownerId !== session.user.id) return { message: 'Unauthorized.' }
  if (order.status !== 'IN_PROGRESS') return { message: 'Order is not in progress.' }

  if (!(RESULT_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return { message: 'Unsupported file type. Result documents must be PDF.' }
  }
  if (fileSize > MAX_RESULT_BYTES) {
    return { message: 'File exceeds 50 MB limit.' }
  }

  const ext   = EXT_BY_MIME[mimeType as ResultMimeType]
  const r2Key = `orders/${order.id}/${createId()}.${ext}`

  const attachment = await prisma.attachment.create({
    data: {
      orderId:        order.id,
      labId:          order.labId,
      uploadedById:   session.user.id,
      attachmentType: 'RESULT',
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
      { allowedPrefix: 'orders/', maxBytes: MAX_RESULT_BYTES },
    )
    return { presignedUrl, r2Key, attachmentId: attachment.id }
  } catch (err) {
    if (err instanceof R2ValidationError || err instanceof R2ConfigError) {
      return { message: 'Storage unavailable. Try again later.' }
    }
    throw err
  }
}
