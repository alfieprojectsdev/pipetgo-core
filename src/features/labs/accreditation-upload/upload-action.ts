'use server'
// Slice: labs/accreditation-upload. Does not transition kycStatus. See README.md.

import { createId } from '@paralleldrive/cuid2'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { generatePresignedPutUrl, R2ValidationError, R2ConfigError } from '@/lib/storage/r2'
import { ALLOWED_MIME_TYPES, MAX_BYTES } from '@/lib/storage/constants'

type ActionState = { message?: string } | null

// documentType value used throughout this slice for ISO 17025 accreditation certificates.
// Listed explicitly in the allowlist — throws on any unknown value so schema evolution
// surfaces as an error rather than silent data corruption. (ref: CLAUDE.md unhandled-states)
const DOCUMENT_TYPE_ALLOWLIST = ['ACCREDITATION_CERTIFICATE'] as const

const EXT_BY_MIME = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
} as const satisfies Record<typeof ALLOWED_MIME_TYPES[number], string>

/**
 * Generates a presigned R2 PUT URL for an ISO 17025 accreditation certificate upload.
 *
 * Two-step flow: this action returns the URL + a LabDocument id; the client PUTs the
 * file directly to R2, then calls confirmUpload to advance the LabDocument to UPLOADED.
 * Role-checked as LAB_ADMIN before any storage or DB write. (ref: DL-007)
 * documentType is validated against DOCUMENT_TYPE_ALLOWLIST — unknown values throw rather
 * than silently inserting an unrecognised type. (ref: CLAUDE.md unhandled-states)
 */
export async function requestUploadUrl(
  _prev: ActionState | { presignedUrl: string; r2Key: string; labDocumentId: string },
  formData: FormData,
): Promise<ActionState | { presignedUrl: string; r2Key: string; labDocumentId: string }> {
  const fileNameValue = formData.get('fileName')
  const mimeTypeValue = formData.get('mimeType')
  const fileSizeRaw = formData.get('fileSize')
  const documentTypeValue = formData.get('documentType')

  const fileName = typeof fileNameValue === 'string' ? fileNameValue : null
  const mimeType = typeof mimeTypeValue === 'string' ? mimeTypeValue : null
  const fileSizeStr = typeof fileSizeRaw === 'string' ? fileSizeRaw : null
  const documentType = typeof documentTypeValue === 'string' ? documentTypeValue : null

  if (!fileName || !mimeType || !fileSizeStr || !documentType) {
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

  const lab = await prisma.lab.findUnique({ where: { ownerId: session.user.id } })
  if (!lab) return { message: 'No lab found for user.' }

  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    return { message: 'Unsupported file type. Allowed: PDF, JPEG, PNG.' }
  }
  if (fileSize > MAX_BYTES) {
    return { message: 'File exceeds 20 MB limit.' }
  }

  if (!(DOCUMENT_TYPE_ALLOWLIST as readonly string[]).includes(documentType)) {
    throw new Error(`Unknown documentType: ${documentType}`)
  }

  const ext = EXT_BY_MIME[mimeType as typeof ALLOWED_MIME_TYPES[number]]
  const r2Key = `labs/${lab.id}/${createId()}.${ext}`

  const doc = await prisma.labDocument.create({
    data: { labId: lab.id, uploadedById: session.user.id, documentType, r2Key, fileName, fileSize, mimeType, status: 'PENDING' },
  })

  try {
    const presignedUrl = await generatePresignedPutUrl(r2Key, mimeType, fileSize)
    return { presignedUrl, r2Key, labDocumentId: doc.id }
  } catch (err) {
    if (err instanceof R2ValidationError || err instanceof R2ConfigError) {
      return { message: 'Storage unavailable. Try again later.' }
    }
    throw err
  }
}
