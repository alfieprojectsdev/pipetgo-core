/**
 * RSC entry point for the client dashboard.
 *
 * Route: /dashboard/client
 * Auth:  CLIENT role only; redirects to /auth/signin otherwise.
 *
 * Date fields are converted to ISO strings before being passed to the client
 * component to prevent Next.js RSC serialization failure on Date objects.
 */

import { redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { ClientDashboardUI } from './ui'

/**
 * All fields are primitive types so Next.js can serialize them across the
 * RSC-to-client boundary without crashing on Date objects. Does not include
 * quotedPrice because the listing view does not display pricing.
 */
export type ClientDashboardOrderDTO = {
  id: string
  serviceName: string
  status: string
  createdAt: string
}

/**
 * Redirects on three conditions: missing session, falsy user id, or non-CLIENT
 * role. The WHERE clause `clientId == session.user.id` is the ownership check —
 * no secondary guard is needed because Order.clientId is set to the authenticated
 * user at creation. (ref: DL-005)
 *
 * `include: { service: true }` eager-loads the join in a single query; no N+1.
 * `orderBy: { createdAt: 'desc' }` returns newest orders first. (ref: DL-002)
 */
export default async function ClientDashboardPage() {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
    redirect('/auth/signin')
  }

  const orders = await prisma.order.findMany({
    where: { clientId: session.user.id },
    include: { service: true },
    orderBy: { createdAt: 'desc' },
  })

  const dtos: ClientDashboardOrderDTO[] = orders.map((order) => ({
    id: order.id,
    serviceName: order.service.name,
    status: order.status,
    createdAt: order.createdAt.toISOString(),
  }))

  return <ClientDashboardUI orders={dtos} />
}
