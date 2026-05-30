'use server'

import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { generatePresignedGetUrl } from '@/lib/storage/r2'

type ViewDocumentResult = { message: string } | { url: string }

/**
 * Mints a 300s presigned GET URL for a single KYC document on admin click.
 *
 * The URL is not embedded in the RSC payload. It is minted on demand so that each
 * access is tied to a fresh ADMIN re-check and the credential is bounded to the
 * 300s TTL rather than the full page lifetime. (ref: DL-004)
 *
 * The R2 key is loaded from the stored LabDocument row (findUnique on @unique id) —
 * it is never derived from client input. generatePresignedGetUrl enforces the labs/
 * prefix guard as defense-in-depth. (ref: DL-004, DL-010)
 */
export async function viewKycDocument(labDocumentId: string): Promise<ViewDocumentResult> {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
    return { message: 'Unauthorized.' }
  }

  const doc = await prisma.labDocument.findUnique({
    where: { id: labDocumentId },
    select: { r2Key: true },
  })

  if (!doc) {
    return { message: 'Document not found.' }
  }

  const url = await generatePresignedGetUrl(doc.r2Key)
  return { url }
}
