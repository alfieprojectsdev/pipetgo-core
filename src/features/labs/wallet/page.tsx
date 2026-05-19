/**
 * RSC entry point for the lab wallet dashboard.
 *
 * Route: /dashboard/lab/wallet
 * Auth:  LAB_ADMIN role only; redirects to /auth/signin otherwise.
 * Guard: Returns 404 if the authenticated user has zero or more than one lab.
 *
 * LabWallet may be null if no orders have been completed yet — the null case
 * is presented as zero balances rather than a 404, because an empty wallet
 * is a valid state for a newly onboarded lab.
 *
 * Decimal fields are converted to toFixed(2) strings and Date fields to ISO
 * strings to prevent Next.js RSC serialization failure.
 */

import { notFound, redirect } from 'next/navigation'
import { type PayoutStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { LabWalletUI } from './ui'

export type LabWalletDTO = {
  pendingBalance: string
  availableBalance: string
  withdrawnTotal: string
  currency: string
}

export type LabPayoutDTO = {
  id: string
  status: PayoutStatus
  grossAmount: string
  platformFee: string
  netAmount: string
  orderId: string
  createdAt: string
  completedAt: string | null
}

export default async function LabWalletPage() {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
    redirect('/auth/signin')
  }

  // Lab.ownerId has @@index but NOT @@unique — findMany guards against silent
  // data loss that findFirst would cause. (ref: DL-006)
  const labs = await prisma.lab.findMany({
    where: { ownerId: session.user.id },
  })

  if (labs.length !== 1) notFound()

  const lab = labs[0]

  const [wallet, payouts] = await Promise.all([
    prisma.labWallet.findUnique({ where: { labId: lab.id } }),
    prisma.payout.findMany({
      where: { labId: lab.id },
      orderBy: { createdAt: 'desc' },
    }),
  ])

  const walletDTO: LabWalletDTO = wallet
    ? {
        pendingBalance: wallet.pendingBalance.toFixed(2),
        availableBalance: wallet.availableBalance.toFixed(2),
        withdrawnTotal: wallet.withdrawnTotal.toFixed(2),
        currency: wallet.currency,
      }
    : {
        pendingBalance: '0.00',
        availableBalance: '0.00',
        withdrawnTotal: '0.00',
        currency: 'PHP',
      }

  const payoutDTOs: LabPayoutDTO[] = payouts.map((p) => ({
    id: p.id,
    status: p.status,
    grossAmount: p.grossAmount.toFixed(2),
    platformFee: p.platformFee.toFixed(2),
    netAmount: p.netAmount.toFixed(2),
    orderId: p.orderId,
    createdAt: p.createdAt.toISOString(),
    completedAt: p.completedAt?.toISOString() ?? null,
  }))

  return <LabWalletUI wallet={walletDTO} payouts={payoutDTOs} />
}
