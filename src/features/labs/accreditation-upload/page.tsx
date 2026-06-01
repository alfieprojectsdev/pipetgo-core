// Slice: labs/accreditation-upload. See README.md for isVerified vs kycStatus distinction.
// RSC — all Date fields serialized to ISO string before crossing to AccreditationUploadUi. (ref: DL-009)
import { notFound, redirect } from 'next/navigation'
import { type DocumentStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { AccreditationUploadUi } from './ui'

export type AccreditationPageDTO = {
  // isVerified reflects whether the admin has verified the ISO 17025 certificate.
  // Distinct from kycStatus — these are independent lifecycle states.
  isVerified: boolean
  // Non-null when a previous accreditation submission was rejected; shown so the
  // lab owner knows what to correct before re-uploading.
  accreditationRejectionReason: string | null
  documents: {
    id: string
    documentType: string
    fileName: string
    mimeType: string
    status: DocumentStatus
    createdAt: string
  }[]
}

export default async function AccreditationPage() {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
    redirect('/auth/signin')
  }

  const lab = await prisma.lab.findUnique({
    where: { ownerId: session.user.id },
    include: {
      documents: {
        where: { documentType: 'ACCREDITATION_CERTIFICATE' },
        orderBy: { createdAt: 'desc' },
      },
    },
  })

  if (!lab) notFound()

  const dto: AccreditationPageDTO = {
    isVerified: lab.isVerified,
    accreditationRejectionReason: lab.accreditationRejectionReason ?? null,
    documents: lab.documents.map((doc) => ({
      id: doc.id,
      documentType: doc.documentType,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      status: doc.status,
      createdAt: doc.createdAt.toISOString(),
    })),
  }

  return <AccreditationUploadUi dto={dto} />
}
