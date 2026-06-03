'use server'

import { auth } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { generatePresignedGetUrl } from '@/lib/storage/r2'

type ViewAttachmentResult = { message: string } | { url: string }

/**
 * Mints a 300s presigned GET URL for an order attachment on admin click.
 * ADMIN is cross-tenant by design — no clientId ownership check. (ref: DL-004, DL-005)
 */
export async function viewOrderAttachment(
  attachmentId: string,
): Promise<ViewAttachmentResult> {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
    return { message: 'Unauthorized.' }
  }

  let doc: { r2Key: string } | null
  try {
    doc = await prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: { r2Key: true },
    })
  } catch {
    return { message: 'Unable to retrieve attachment.' }
  }

  if (!doc) {
    return { message: 'Attachment not found.' }
  }

  let url: string
  try {
    url = await generatePresignedGetUrl(doc.r2Key, { allowedPrefix: 'orders/' })
  } catch {
    return { message: 'Unable to retrieve attachment.' }
  }

  return { url }
}
