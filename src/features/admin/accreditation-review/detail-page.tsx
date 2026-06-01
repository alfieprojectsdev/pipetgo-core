/**
 * Admin accreditation detail RSC for a single lab.
 * LabAccreditationDetailDTO carries all Date fields as .toISOString() strings.
 * Next.js cannot serialize Prisma Date or Decimal types across the RSC boundary. (ref: DL-009)
 * A null owner after an explicit include is a referential-integrity violation. (ref: DL-001)
 * See README.md for full design rationale.
 */
import { notFound, redirect } from 'next/navigation'
import { type DocumentStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { AdminAccreditationDetailUi } from './detail-ui'

export type LabAccreditationDetailDTO = {
  id: string
  name: string
  isVerified: boolean
  accreditationReviewedAt: string | null
  accreditationRejectionReason: string | null
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

export default async function AdminAccreditationDetailPage({
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
      documents: {
        where: { documentType: 'ACCREDITATION_CERTIFICATE' },
        orderBy: { createdAt: 'desc' },
      },
    },
  })

  if (!lab) notFound()
  if (!lab.owner) {
    throw new Error('Lab.owner missing after explicit include — referential integrity violation')
  }

  const dto: LabAccreditationDetailDTO = {
    id: lab.id,
    name: lab.name,
    isVerified: lab.isVerified,
    accreditationReviewedAt: lab.accreditationReviewedAt ? lab.accreditationReviewedAt.toISOString() : null,
    accreditationRejectionReason: lab.accreditationRejectionReason ?? null,
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

  return <AdminAccreditationDetailUi dto={dto} />
}
