import { notFound, redirect } from 'next/navigation'
import { OrderStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { isWithinDisputeWindow } from '@/domain/orders/dispute'
import { DisputeForm } from './ui'

/**
 * All Date fields serialized to ISO string before crossing the RSC boundary.
 * Prisma.Decimal and Date cannot be serialized by Next.js; DTO fields are
 * typed string to reflect the serialized form (ref: CLAUDE.md discipline).
 */
export type DisputePageDTO = {
  orderId: string
  serviceName: string
  labName: string
  completedAt: string
}

/**
 * Route: /dashboard/orders/[orderId]/dispute
 * Auth:  CLIENT role; ownership enforced here and again in the action (TOCTOU).
 * Guard: COMPLETED status + within-window required; out-of-window renders the
 *        form pre-populated with an error via the DTO or redirects — handled in
 *        the action. Missing order or wrong owner -> notFound().
 */
export default async function DisputePage({
  params,
}: {
  params: { orderId: string }
}) {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
    redirect('/auth/signin')
  }

  const order = await prisma.order.findUnique({
    where: { id: params.orderId },
    include: {
      service: { select: { name: true } },
      lab: { select: { name: true } },
    },
  })

  if (!order) notFound()
  if (order.clientId !== session.user.id) notFound()
  if (!order.service) throw new Error('Order.service missing after explicit include — referential integrity violation')
  if (!order.lab) throw new Error('Order.lab missing after explicit include — referential integrity violation')

  if (order.status !== OrderStatus.COMPLETED) notFound()
  if (!order.completedAt || !isWithinDisputeWindow(order.completedAt, new Date())) notFound()

  const dto: DisputePageDTO = {
    orderId: order.id,
    serviceName: order.service.name,
    labName: order.lab.name,
    completedAt: order.completedAt.toISOString(),
  }

  return <DisputeForm dto={dto} />
}
