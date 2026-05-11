import { notFound, redirect } from 'next/navigation'
import { OrderStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import QuoteProvidePage from '@/features/orders/quote-provide/page'
import LabFulfillmentPage from '@/features/orders/lab-fulfillment/page'

export default async function LabOrderDispatchPage({
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
    select: { status: true },
  })

  if (!order) notFound()

  switch (order.status) {
    case OrderStatus.QUOTE_REQUESTED:
      return <QuoteProvidePage params={params} />
    case OrderStatus.ACKNOWLEDGED:
    case OrderStatus.IN_PROGRESS:
      return <LabFulfillmentPage params={params} />
    default:
      notFound()
  }
}
