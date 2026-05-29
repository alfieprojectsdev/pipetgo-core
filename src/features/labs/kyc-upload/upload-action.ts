'use server'

import { createId } from '@paralleldrive/cuid2'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { generatePresignedPutUrl, ALLOWED_MIME_TYPES, MAX_BYTES, R2ValidationError, R2ConfigError } from '@/lib/storage/r2'

type ActionState = { message?: string } | null

const DOCUMENT_TYPE_ALLOWLIST = ['BIR_2303', 'DTI_SEC', 'OTHER'] as const

const EXT_BY_MIME = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
} as const satisfies Record<typeof ALLOWED_MIME_TYPES[number], string>

export async function requestUploadUrl(
  _prev: ActionState | { presignedUrl: string; r2Key: string; labDocumentId: string },
  formData: FormData,
): Promise<ActionState | { presignedUrl: string; r2Key: string; labDocumentId: string }> {
  const fileName = formData.get('fileName') as string | null
  const mimeType = formData.get('mimeType') as string | null
  const fileSizeRaw = formData.get('fileSize') as string | null
  const documentType = formData.get('documentType') as string | null

  if (!fileName || !mimeType || !fileSizeRaw || !documentType) {
    return { message: 'Missing field.' }
  }

  const fileSize = Number(fileSizeRaw)
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
    return { message: `Unsupported file type. Allowed: PDF, JPEG, PNG.` }
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
