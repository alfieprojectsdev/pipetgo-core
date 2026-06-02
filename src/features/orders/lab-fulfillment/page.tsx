/**
 * RSC entry point for the lab fulfillment page.
 *
 * Route: /dashboard/lab/orders/[orderId]
 * Auth:  LAB_ADMIN role only; redirects to /auth/signin otherwise.
 * Guard: Renders 404 for any order that does not belong to the authenticated
 *        lab admin (lab.ownerId !== session.user.id) or is not in ACKNOWLEDGED
 *        or IN_PROGRESS status. Throws if lab relation is null after explicit
 *        include — that is a referential integrity violation, not a 404.
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
import { ResultUploadUi, SpecAttachmentListUi } from '../result-upload/ui'

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
  // specAttachments: SPECIFICATION files the CLIENT attached to this order,
  // filtered at the DTO level so ResultUploadUi receives only the relevant subset.
  // resultAttachments: RESULT PDFs uploaded by this lab for the order.
  // Both lists serialize Date→toISOString at the RSC boundary. (ref: DL-001)
  specAttachments: { id: string; fileName: string; createdAt: string }[]
  resultAttachments: { id: string; fileName: string; createdAt: string }[]
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

  if (!order) notFound()
  if (!order.lab) throw new Error(`Order ${params.orderId} missing lab after explicit include — referential integrity violation`)
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

  const allAttachments = await prisma.attachment.findMany({
    where:   { orderId: params.orderId },
    select:  { id: true, fileName: true, createdAt: true, attachmentType: true },
    orderBy: { createdAt: 'asc' },
  })

  const specAttachments = allAttachments
    .filter((a) => a.attachmentType === 'SPECIFICATION')
    .map((a) => ({ id: a.id, fileName: a.fileName, createdAt: a.createdAt.toISOString() }))

  const resultAttachments = allAttachments
    .filter((a) => a.attachmentType === 'RESULT')
    .map((a) => ({ id: a.id, fileName: a.fileName, createdAt: a.createdAt.toISOString() }))

  const dto: LabOrderDTO = {
    id: order.id,
    serviceName: order.service.name,
    quotedPrice: order.quotedPrice != null ? order.quotedPrice.toFixed(2) : '0.00',
    status: order.status,
    notes: order.notes ?? null,
    clientName: order.clientProfile.name,
    clientEmail: order.clientProfile.email,
    createdAt: order.createdAt.toISOString(),
    specAttachments,
    resultAttachments,
  }

  return (
    <div className="space-y-6">
      <LabFulfillmentUI order={dto} />
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Specification Documents</h2>
          <SpecAttachmentListUi attachments={specAttachments} />
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Result Documents</h2>
          <ResultUploadUi orderId={params.orderId} attachments={resultAttachments} />
        </div>
      </div>
    </div>
  )
}
