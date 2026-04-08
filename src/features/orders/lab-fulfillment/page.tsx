/**
 * RSC entry point for the lab fulfillment page.
 *
 * Route: /dashboard/lab/orders/[orderId]
 * Auth:  LAB_ADMIN role only; redirects to /auth/signin otherwise.
 * Guard: Renders 404 for any order that does not belong to the authenticated
 *        lab admin (lab.ownerId !== session.user.id), lacks a lab relation,
 *        or is not in ACKNOWLEDGED or IN_PROGRESS status.
 *
 * Decimal fields (Order.quotedPrice) are converted to string before being passed
 * to the client component to prevent Next.js RSC serialization failure on
 * Prisma.Decimal values.
 */

import { notFound, redirect } from 'next/navigation'
import { OrderStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { LabFulfillmentUI } from './ui'

/**
 * All fields are primitive strings so Next.js can serialize them across the
 * RSC-to-client boundary without crashing on Prisma.Decimal or Date objects.
 */
export type LabOrderDTO = {
  id: string
  serviceName: string
  quotedPrice: string
  status: string
  notes: string | null
  clientName: string
  clientEmail: string
  createdAt: string
}

export default async function LabFulfillmentPage({
  params,
}: {
  params: { orderId: string }
}) {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
    redirect('/auth/signin')
  }

  // LAB_ADMIN is the correct schema enum value. The Prisma UserRole enum has
  // CLIENT, LAB_ADMIN, and ADMIN — there is no LAB variant. (ref: DL-001)
  const order = await prisma.order.findUnique({
    where: { id: params.orderId },
    include: { lab: true, service: true, clientProfile: true },
  })

  if (!order || !order.lab) notFound()
  // notFound() prevents information leakage: the caller cannot distinguish
  // a missing order from one that belongs to a different lab. (ref: DL-004)
  if (order.lab.ownerId !== session.user.id) notFound()
  if (
    order.status !== OrderStatus.ACKNOWLEDGED &&
    order.status !== OrderStatus.IN_PROGRESS
  ) {
    notFound()
  }
  if (!order.clientProfile) notFound()

  const dto: LabOrderDTO = {
    id: order.id,
    serviceName: order.service.name,
    quotedPrice: order.quotedPrice != null ? order.quotedPrice.toFixed(2) : '0.00',
    status: order.status,
    notes: order.notes ?? null,
    clientName: order.clientProfile.name,
    clientEmail: order.clientProfile.email,
    createdAt: order.createdAt.toISOString(),
  }

  return <LabFulfillmentUI order={dto} />
}
