/**
 * RSC entry point for the lab dashboard.
 *
 * Route: /dashboard/lab
 * Auth:  LAB_ADMIN role only; redirects to /auth/signin otherwise.
 * Guard: Returns 404 if the authenticated user has no lab.
 *
 * Date fields are converted to ISO strings before being passed to the client
 * component to prevent Next.js RSC serialization failure on Date objects.
 */

import { notFound, redirect } from 'next/navigation'
import { OrderStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { LabDashboardUI } from './ui'

/**
 * All fields are primitive types so Next.js can serialize them across the
 * RSC-to-client boundary without crashing on Date objects. Does not include
 * quotedPrice because the listing view does not display pricing.
 */
export type LabDashboardOrderDTO = {
  id: string
  serviceName: string
  clientName: string
  status: string
  createdAt: string
}

export default async function LabDashboardPage() {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
    redirect('/auth/signin')
  }

  // Lab.ownerId is @unique (added T-15) — findUnique enforces the constraint at the query level.
  const lab = await prisma.lab.findUnique({
    where: { ownerId: session.user.id },
  })

  if (!lab) notFound()

  const orders = await prisma.order.findMany({
    where: {
      labId: lab.id,
      status: {
        in: [
          OrderStatus.QUOTE_REQUESTED,
          OrderStatus.QUOTE_REJECTED,
          OrderStatus.ACKNOWLEDGED,
          OrderStatus.IN_PROGRESS,
          OrderStatus.COMPLETED,
          OrderStatus.CANCELLED,
        ],
      },
    },
    include: { service: true, clientProfile: true },
    orderBy: { createdAt: 'asc' },
  })

  // clientProfile?.name fallback preserves all orders in the listing.
  // Filtering out null clientProfile orders would silently drop real orders
  // from the lab admin view. (ref: DL-004)
  const dtos: LabDashboardOrderDTO[] = orders.map((order) => ({
    id: order.id,
    serviceName: order.service.name,
    clientName: order.clientProfile?.name ?? 'Unknown Client',
    status: order.status,
    createdAt: order.createdAt.toISOString(),
  }))

  return <LabDashboardUI orders={dtos} />
}
