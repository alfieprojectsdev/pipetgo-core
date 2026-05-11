import { notFound, redirect } from 'next/navigation'
import { OrderStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { QuoteProvideUI } from './ui'

export type QuoteOrderDTO = {
  id: string
  serviceName: string
  clientName: string | null
  clientEmail: string | null
  quantity: number
  notes: string | null
  createdAt: string
}

export default async function QuoteProvidePage({
  params,
}: {
  params: { orderId: string }
}) {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
    redirect('/auth/signin')
  }

  const order = await prisma.order.findUnique({
    where: { id: params.orderId },
    include: { service: true, lab: true, clientProfile: true },
  })

  if (!order || !order.lab || order.lab.ownerId !== session.user.id) notFound()
  if (order.status !== OrderStatus.QUOTE_REQUESTED) notFound()

  const dto: QuoteOrderDTO = {
    id: order.id,
    serviceName: order.service.name,
    clientName: order.clientProfile?.name ?? null,
    clientEmail: order.clientProfile?.email ?? null,
    quantity: order.quantity,
    notes: order.notes ?? null,
    createdAt: order.createdAt.toISOString(),
  }

  return <QuoteProvideUI orderId={order.id} order={dto} />
}
