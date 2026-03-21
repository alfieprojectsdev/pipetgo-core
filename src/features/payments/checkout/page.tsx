/**
 * RSC entry point for the deferred-payment checkout page.
 *
 * Route: /dashboard/orders/[orderId]/pay
 * Auth:  CLIENT role only; redirects to /auth/signin otherwise.
 * Guard: Renders 404 for any order that is not PAYMENT_PENDING, belongs to a
 *        different client, or lacks a clientProfile.
 *
 * Decimal fields (Order.quotedPrice) are converted to string before being passed
 * to the client component to prevent Next.js RSC serialization failure on
 * Prisma.Decimal values.
 */

import { notFound, redirect } from 'next/navigation'
import { OrderStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { PaymentSummary } from './ui'

/**
 * All fields are primitive strings so Next.js can serialize them across the
 * RSC-to-client boundary without crashing on Prisma.Decimal or Date objects.
 * Adding any non-serializable type here will cause a runtime crash.
 */
export type CheckoutOrderDTO = {
  id: string
  serviceName: string
  quotedPrice: string
  clientEmail: string
  clientName: string
  createdAt: string
}

/**
 * quotedPrice non-null assertion is safe: resolveOrderInitialState always sets
 * quotedPrice before transitioning to PAYMENT_PENDING, so reaching this page
 * guarantees a non-null value. The status guard above enforces this precondition.
 */
export default async function CheckoutPage({
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
    include: { clientProfile: true, service: true },
  })

  if (!order || order.clientId !== session.user.id) notFound()
  if (order.status !== OrderStatus.PAYMENT_PENDING) notFound()
  if (!order.clientProfile) notFound()

  const dto: CheckoutOrderDTO = {
    id: order.id,
    serviceName: order.service.name,
    quotedPrice: order.quotedPrice!.toFixed(2),
    clientEmail: order.clientProfile.email,
    clientName: order.clientProfile.name,
    createdAt: order.createdAt.toISOString(),
  }

  return <PaymentSummary order={dto} />
}
