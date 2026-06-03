/**
 * Admin order detail RSC.
 * Role check duplicated from layout.tsx (ref: DL-001). findUnique on @id;
 * null relation after explicit include throws (not notFound) except clientProfile
 * which is a nullable 1:1. (ref: DL-005, DL-006)
 * All Decimal fields serialized via .toFixed(2) / .toFixed(4); all Date fields
 * via .toISOString(). (ref: DL-007, DL-002)
 */
import { notFound, redirect } from 'next/navigation'
import { type OrderStatus, type TransactionStatus, type PayoutStatus, type AttachmentType } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { AdminOrderDetailUi } from './detail-ui'

export type AdminOrderDetailDTO = {
  id: string
  status: OrderStatus
  quotedPrice: string | null
  quotedAt: string | null
  paidAt: string | null
  refundedAt: string | null
  createdAt: string
  updatedAt: string
  lab: { name: string }
  service: { name: string }
  client: { name: string | null; email: string }
  // clientProfile is a nullable 1:1 (not all Orders have a ClientProfile row);
  // null here is a valid data state, not a referential integrity violation. (ref: DL-006)
  clientProfile: {
    name: string
    email: string
    phone: string
    organization: string | null
    address: string | null
  } | null
  transactions: {
    id: string
    amount: string
    status: TransactionStatus
    paymentMethod: string | null
    capturedAt: string | null
    createdAt: string
  }[]
  payouts: {
    id: string
    grossAmount: string
    platformFee: string
    netAmount: string
    feePercentage: string
    status: PayoutStatus
    scheduledDate: string | null
    completedAt: string | null
    createdAt: string
  }[]
  attachments: {
    id: string
    fileName: string
    attachmentType: AttachmentType
    createdAt: string
  }[]
}

export default async function AdminOrderDetailPage({
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
      client: true,
      clientProfile: true,
      lab: true,
      service: true,
      transactions: { orderBy: { createdAt: 'desc' } },
      payouts: { orderBy: { createdAt: 'desc' } },
      attachments: { orderBy: { createdAt: 'desc' } },
    },
  })

  if (!order) notFound()
  if (!order.lab) {
    // lab is schema-guaranteed via FK — null after explicit include is a referential
    // integrity violation, not a missing-row scenario. (ref: DL-006)
    throw new Error(`Order.lab missing after explicit include — referential integrity violation`)
  }
  if (!order.service) {
    throw new Error(`Order.service missing after explicit include — referential integrity violation`)
  }
  if (!order.client) {
    throw new Error(`Order.client missing after explicit include — referential integrity violation`)
  }

  const dto: AdminOrderDetailDTO = {
    id: order.id,
    status: order.status,
    quotedPrice: order.quotedPrice?.toFixed(2) ?? null,
    quotedAt: order.quotedAt?.toISOString() ?? null,
    paidAt: order.paidAt?.toISOString() ?? null,
    refundedAt: order.refundedAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    lab: { name: order.lab.name },
    service: { name: order.service.name },
    client: {
      name: order.client.name ?? null,
      email: order.client.email,
    },
    clientProfile: order.clientProfile
      ? {
          name: order.clientProfile.name,
          email: order.clientProfile.email,
          phone: order.clientProfile.phone,
          organization: order.clientProfile.organization ?? null,
          address: order.clientProfile.address ?? null,
        }
      : null,
    transactions: order.transactions.map((t) => ({
      id: t.id,
      amount: t.amount.toFixed(2),
      status: t.status,
      paymentMethod: t.paymentMethod ?? null,
      capturedAt: t.capturedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
    })),
    payouts: order.payouts.map((p) => ({
      id: p.id,
      grossAmount: p.grossAmount.toFixed(2),
      platformFee: p.platformFee.toFixed(2),
      netAmount: p.netAmount.toFixed(2),
      feePercentage: p.feePercentage.toFixed(4),
      status: p.status,
      scheduledDate: p.scheduledDate?.toISOString() ?? null,
      completedAt: p.completedAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
    })),
    attachments: order.attachments.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      attachmentType: a.attachmentType,
      createdAt: a.createdAt.toISOString(),
    })),
  }

  return <AdminOrderDetailUi dto={dto} />
}
