import { notFound, redirect } from 'next/navigation'
import { type KycStatus, type DocumentStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { KycUploadUi } from './ui'

export type KycPageDTO = {
  kycStatus: KycStatus
  documents: {
    id: string
    documentType: string
    fileName: string
    mimeType: string
    status: DocumentStatus
    createdAt: string
  }[]
}

export default async function KycPage() {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
    redirect('/auth/signin')
  }

  const lab = await prisma.lab.findUnique({
    where: { ownerId: session.user.id },
    include: { documents: { orderBy: { createdAt: 'desc' } } },
  })

  if (!lab) notFound()

  const dto: KycPageDTO = {
    kycStatus: lab.kycStatus,
    documents: lab.documents.map((doc) => ({
      id: doc.id,
      documentType: doc.documentType,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      status: doc.status,
      createdAt: doc.createdAt.toISOString(),
    })),
  }

  return <KycUploadUi dto={dto} />
}
