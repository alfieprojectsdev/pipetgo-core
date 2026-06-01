/**
 * Admin accreditation review queue RSC.
 * Lists labs that are unverified (isVerified=false) AND have at least one
 * ACCREDITATION_CERTIFICATE LabDocument with status=UPLOADED, ordered by
 * Lab.createdAt asc (creation order, FIFO proxy — mirrors KYC queue ordering).
 * Role check duplicated from layout.tsx: Server Actions and RSCs are independently
 * invocable; the layout guard does not protect them. (ref: DL-001)
 * See README.md for full design rationale.
 */
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { AdminAccreditationQueueUi } from './ui'

export type AccreditationQueueDTO = {
  id: string
  name: string
  createdAt: string
  ownerEmail: string
  accreditationRejectionReason: string | null
}

export default async function AdminAccreditationQueuePage() {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
    redirect('/auth/signin')
  }

  const labs = await prisma.lab.findMany({
    where: {
      isVerified: false,
      documents: {
        some: {
          documentType: 'ACCREDITATION_CERTIFICATE',
          status: 'UPLOADED',
        },
      },
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      name: true,
      createdAt: true,
      accreditationRejectionReason: true,
      owner: { select: { email: true } },
    },
  })

  const queue: AccreditationQueueDTO[] = labs.map((lab) => ({
    id: lab.id,
    name: lab.name,
    createdAt: lab.createdAt.toISOString(),
    ownerEmail: lab.owner.email,
    accreditationRejectionReason: lab.accreditationRejectionReason,
  }))

  return <AdminAccreditationQueueUi queue={queue} />
}
