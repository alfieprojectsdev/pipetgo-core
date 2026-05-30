/**
 * Admin KYC detail RSC for a single lab.
 * LabKycDetailDTO carries all Date fields as .toISOString() strings and no
 * Prisma.Decimal fields — Next.js cannot serialize those types across the RSC
 * boundary. (ref: DL-009)
 * A null owner after an explicit include is a referential-integrity violation, not a
 * missing-row scenario, and throws rather than calling notFound(). (ref: DL-001, DL-010)
 */
import { notFound, redirect } from 'next/navigation'
import { type KycStatus, type DocumentStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { AdminKycDetailUi } from './detail-ui'

export type LabKycDetailDTO = {
  id: string
  name: string
  kycStatus: KycStatus
  kycReviewedAt: string | null
  kycRejectionReason: string | null
  ownerName: string | null
  ownerEmail: string
  documents: {
    id: string
    documentType: string
    fileName: string
    mimeType: string
    status: DocumentStatus
    createdAt: string
  }[]
}

export default async function AdminKycDetailPage({
  params,
}: {
  params: { labId: string }
}) {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
    redirect('/auth/signin')
  }

  const lab = await prisma.lab.findUnique({
    where: { id: params.labId },
    include: {
      owner: true,
      documents: { orderBy: { createdAt: 'desc' } },
    },
  })

  if (!lab) notFound()
  if (!lab.owner) {
    throw new Error('Lab.owner missing after explicit include — referential integrity violation')
  }

  const dto: LabKycDetailDTO = {
    id: lab.id,
    name: lab.name,
    kycStatus: lab.kycStatus,
    kycReviewedAt: lab.kycReviewedAt ? lab.kycReviewedAt.toISOString() : null,
    kycRejectionReason: lab.kycRejectionReason,
    ownerName: lab.owner.name ?? null,
    ownerEmail: lab.owner.email,
    documents: lab.documents.map((doc) => ({
      id: doc.id,
      documentType: doc.documentType,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      status: doc.status,
      createdAt: doc.createdAt.toISOString(),
    })),
  }

  return <AdminKycDetailUi dto={dto} />
}
