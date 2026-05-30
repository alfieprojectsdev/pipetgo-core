/**
 * Admin KYC review queue RSC.
 * Lists labs with kycStatus=SUBMITTED ordered by Lab.createdAt asc (lab creation order,
 * used as a proxy for queue age — FIFO bounds worst-case wait for revenue-blocked labs). (ref: DL-012)
 * Role check duplicated from layout.tsx: Server Actions and RSCs are independently
 * invocable; the layout guard does not protect them. (ref: DL-001)
 */
import { redirect } from 'next/navigation'
import { type KycStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { AdminKycQueueUi } from './ui'

export type LabQueueDTO = {
  id: string
  name: string
  kycStatus: KycStatus
  createdAt: string
  ownerEmail: string
}

export default async function AdminKycQueuePage() {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
    redirect('/auth/signin')
  }

  const labs = await prisma.lab.findMany({
    where: { kycStatus: 'SUBMITTED' },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      name: true,
      kycStatus: true,
      createdAt: true,
      owner: { select: { email: true } },
    },
  })

  const queue: LabQueueDTO[] = labs.map((lab) => ({
    id: lab.id,
    name: lab.name,
    kycStatus: lab.kycStatus,
    createdAt: lab.createdAt.toISOString(),
    ownerEmail: lab.owner.email,
  }))

  return <AdminKycQueueUi queue={queue} />
}
