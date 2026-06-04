import { notFound, redirect } from 'next/navigation'
import { OrderStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { DisputeResolutionForm } from './ui'
import { DisputeListUi } from './list-ui'

/**
 * All Date/Decimal fields serialized before crossing the RSC boundary.
 * completedAt is null for orders that predate the dispute-window feature; treat as out-of-window (ref: DL-010).
 * quotedPrice is null when no quote was accepted.
 */
export type DisputedOrderDTO = {
  id: string
  serviceName: string
  labName: string
  clientEmail: string
  quotedPrice: string | null
  completedAt: string | null
  disputeReason: string
  disputeOpenedAt: string
}

export type DisputeDetailDTO = DisputedOrderDTO & {
  disputeId: string
}

/**
 * List route: /dashboard/admin/disputes
 * Auth: ADMIN role re-checked here (layer-2 TOCTOU; layout is layer-1 only).
 */
export async function DisputeListPage() {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
    redirect('/auth/signin')
  }

  const orders = await prisma.order.findMany({
    where: { status: OrderStatus.DISPUTED },
    include: {
      service: { select: { name: true } },
      lab: { select: { name: true } },
      client: { select: { email: true } },
      dispute: true,
    },
    orderBy: { updatedAt: 'asc' },
  })

  const rows: DisputedOrderDTO[] = orders.map((o) => {
    if (!o.dispute) throw new Error(`Order ${o.id} DISPUTED but OrderDispute missing after explicit include — referential integrity violation`)
    return {
      id: o.id,
      serviceName: o.service.name,
      labName: o.lab.name,
      clientEmail: o.client.email,
      quotedPrice: o.quotedPrice != null ? o.quotedPrice.toFixed(2) : null,
      completedAt: o.completedAt ? o.completedAt.toISOString() : null,
      disputeReason: o.dispute.reason,
      disputeOpenedAt: o.dispute.openedAt.toISOString(),
    }
  })

  return <DisputeListUi rows={rows} />
}

/**
 * Detail route: /dashboard/admin/disputes/[orderId]
 * Auth: ADMIN role re-checked here (layer-2 TOCTOU; layout is layer-1 only, ref: DL-006).
 * Null order -> notFound(); null dispute after explicit include -> throws
 * (referential integrity violation, not a missing-row scenario).
 */
export default async function DisputeDetailPage({
  params,
}: {
  params: { orderId: string }
}) {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
    redirect('/auth/signin')
  }

  const order = await prisma.order.findUnique({
    where: { id: params.orderId },
    include: {
      service: { select: { name: true } },
      lab: { select: { name: true } },
      client: { select: { email: true } },
      dispute: true,
    },
  })

  // Status guard before the relation invariant (defense-in-depth): a stale or
  // hand-entered URL for a resolved/never-disputed order is notFound(), not a
  // referential-integrity throw. Only an order actually in DISPUTED reaches the
  // invariant below, where a missing dispute IS a genuine integrity violation.
  if (!order || order.status !== OrderStatus.DISPUTED) notFound()
  if (!order.dispute) throw new Error('Order.dispute missing after explicit include — referential integrity violation for DISPUTED order')

  const dto: DisputeDetailDTO = {
    id: order.id,
    disputeId: order.dispute.id,
    serviceName: order.service.name,
    labName: order.lab.name,
    clientEmail: order.client.email,
    quotedPrice: order.quotedPrice != null ? order.quotedPrice.toFixed(2) : null,
    completedAt: order.completedAt ? order.completedAt.toISOString() : null,
    disputeReason: order.dispute.reason,
    disputeOpenedAt: order.dispute.openedAt.toISOString(),
  }

  return <DisputeResolutionForm dto={dto} />
}
