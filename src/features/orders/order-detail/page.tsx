import { notFound, redirect } from 'next/navigation'
import { OrderStatus, PricingMode } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'

// Intentionally duplicated from clients/dashboard/ui.tsx — cross-slice import violates ADR-001.
// Typed Record<OrderStatus, ...> so a missing enum value is a compile error at build time.
// The ?? on the badge lookup (below) is intentional deploy-safety: guards against the window
// where a DB migration adds a new enum value before the Prisma client is regenerated.
const statusBadgeConfig: Record<OrderStatus, { label: string; className: string }> = {
  [OrderStatus.QUOTE_REQUESTED]: { label: 'Quote Requested', className: 'bg-gray-100 text-gray-700' },
  [OrderStatus.QUOTE_PROVIDED]:  { label: 'Quote Provided',  className: 'bg-yellow-100 text-yellow-800' },
  [OrderStatus.QUOTE_REJECTED]:  { label: 'Quote Rejected',  className: 'bg-red-100 text-red-800' },
  [OrderStatus.PENDING]:         { label: 'Pending',         className: 'bg-yellow-100 text-yellow-800' },
  [OrderStatus.PAYMENT_PENDING]: { label: 'Payment Pending', className: 'bg-yellow-100 text-yellow-800' },
  [OrderStatus.PAYMENT_FAILED]:  { label: 'Payment Failed',  className: 'bg-red-100 text-red-800' },
  [OrderStatus.ACKNOWLEDGED]:    { label: 'Acknowledged',    className: 'bg-blue-100 text-blue-800' },
  [OrderStatus.IN_PROGRESS]:     { label: 'In Progress',     className: 'bg-blue-100 text-blue-800' },
  [OrderStatus.COMPLETED]:       { label: 'Completed',       className: 'bg-green-100 text-green-800' },
  [OrderStatus.CANCELLED]:       { label: 'Cancelled',       className: 'bg-red-100 text-red-800' },
  [OrderStatus.REFUND_PENDING]:  { label: 'Refund Pending',  className: 'bg-yellow-100 text-yellow-800' },
  [OrderStatus.REFUNDED]:        { label: 'Refunded',        className: 'bg-gray-100 text-gray-700' },
}

export type OrderDetailDTO = {
  id: string
  status: string
  pricingMode: PricingMode
  serviceName: string
  labName: string
  quotedPrice: string | null
  createdAt: string
  quotedAt: string | null
  paidAt: string | null
  clientName: string | null
  clientEmail: string | null
  clientPhone: string | null
  clientOrganization: string | null
  clientAddress: string | null
  quantity: number
  notes: string | null
}

type TimelineStep = {
  id: string
  label: string
  date: string | null
  state: 'done' | 'current' | 'pending'
}

function getTimelineSteps(
  status: string,
  pricingMode: PricingMode,
  createdAt: string,
  quotedAt: string | null,
  paidAt: string | null,
): TimelineStep[] {
  const s = status as OrderStatus

  // Canonical status ordering for the main flow
  const mainFlowOrder: OrderStatus[] = [
    OrderStatus.QUOTE_REQUESTED,
    OrderStatus.QUOTE_PROVIDED,
    OrderStatus.PENDING,
    OrderStatus.PAYMENT_PENDING,
    OrderStatus.ACKNOWLEDGED,
    OrderStatus.IN_PROGRESS,
    OrderStatus.COMPLETED,
  ]

  const stepMeta: Partial<Record<OrderStatus, { label: string; date: string | null }>> = {
    [OrderStatus.QUOTE_REQUESTED]: { label: 'Order Submitted',   date: createdAt },
    [OrderStatus.QUOTE_PROVIDED]:  { label: 'Quote Provided',    date: quotedAt },
    [OrderStatus.PENDING]:         { label: 'Quote Accepted',    date: null },
    [OrderStatus.PAYMENT_PENDING]: { label: 'Payment Pending',   date: null },
    [OrderStatus.ACKNOWLEDGED]:    { label: 'Lab Acknowledged',  date: paidAt },
    [OrderStatus.IN_PROGRESS]:     { label: 'In Progress',       date: null },
    [OrderStatus.COMPLETED]:       { label: 'Completed',         date: null },
  }

  if (s === OrderStatus.CANCELLED) {
    // Reconstruct how far the order progressed using available date fields —
    // the current CANCELLED status carries no history, so we infer from dates.
    const steps: TimelineStep[] = [
      { id: OrderStatus.QUOTE_REQUESTED, label: 'Order Submitted', date: createdAt, state: 'done' },
    ]
    if (quotedAt) {
      steps.push({ id: OrderStatus.QUOTE_PROVIDED, label: 'Quote Provided',  date: quotedAt, state: 'done' })
      steps.push({ id: OrderStatus.PENDING,         label: 'Quote Accepted',  date: null,     state: 'done' })
    }
    if (paidAt) {
      steps.push({ id: OrderStatus.PAYMENT_PENDING, label: 'Payment Pending', date: null,    state: 'done' })
      steps.push({ id: OrderStatus.ACKNOWLEDGED,    label: 'Lab Acknowledged', date: paidAt, state: 'done' })
    }
    steps.push({ id: OrderStatus.CANCELLED, label: 'Cancelled', date: null, state: 'current' })
    return steps
  }

  if (s === OrderStatus.REFUND_PENDING || s === OrderStatus.REFUNDED) {
    return [
      { id: OrderStatus.COMPLETED,     label: 'Completed',      date: null, state: 'done' as const },
      { id: OrderStatus.REFUND_PENDING, label: 'Refund Pending', date: null,
        state: s === OrderStatus.REFUNDED ? 'done' : 'current' as const },
      { id: OrderStatus.REFUNDED,      label: 'Refunded',       date: null,
        state: s === OrderStatus.REFUNDED ? 'current' : 'pending' as const },
    ]
  }

  if (s === OrderStatus.QUOTE_REJECTED) {
    return [
      { id: OrderStatus.QUOTE_REQUESTED, label: 'Order Submitted', date: createdAt, state: 'done' as const },
      { id: OrderStatus.QUOTE_PROVIDED,  label: 'Quote Provided',  date: quotedAt,  state: 'done' as const },
      { id: OrderStatus.QUOTE_REJECTED,  label: 'Quote Rejected',  date: null,      state: 'current' as const },
    ]
  }

  if (s === OrderStatus.PAYMENT_FAILED) {
    return [
      { id: OrderStatus.QUOTE_REQUESTED, label: 'Order Submitted',  date: createdAt, state: 'done' as const },
      { id: OrderStatus.QUOTE_PROVIDED,  label: 'Quote Provided',   date: quotedAt,  state: 'done' as const },
      { id: OrderStatus.PENDING,         label: 'Quote Accepted',   date: null,      state: 'done' as const },
      { id: OrderStatus.PAYMENT_PENDING, label: 'Payment Pending',  date: null,      state: 'done' as const },
      { id: OrderStatus.PAYMENT_FAILED,  label: 'Payment Failed',   date: null,      state: 'current' as const },
    ]
  }

  // FIXED and HYBRID orders skip the quote flow — show only steps they actually traverse.
  if (pricingMode === PricingMode.FIXED || pricingMode === PricingMode.HYBRID) {
    const fixedFlow: OrderStatus[] = [
      OrderStatus.QUOTE_REQUESTED,
      OrderStatus.PAYMENT_PENDING,
      OrderStatus.ACKNOWLEDGED,
      OrderStatus.IN_PROGRESS,
      OrderStatus.COMPLETED,
    ]
    const fixedMeta: Partial<Record<OrderStatus, { label: string; date: string | null }>> = {
      [OrderStatus.QUOTE_REQUESTED]: { label: 'Order Submitted',  date: createdAt },
      [OrderStatus.PAYMENT_PENDING]: { label: 'Payment Pending',  date: null },
      [OrderStatus.ACKNOWLEDGED]:    { label: 'Lab Acknowledged', date: paidAt },
      [OrderStatus.IN_PROGRESS]:     { label: 'In Progress',      date: null },
      [OrderStatus.COMPLETED]:       { label: 'Completed',        date: null },
    }
    const fixedIndex = fixedFlow.indexOf(s)
    return fixedFlow.map((step, i) => ({
      id: step,
      label: fixedMeta[step]?.label ?? step,
      date: fixedMeta[step]?.date ?? null,
      state: (i < fixedIndex ? 'done' : i === fixedIndex ? 'current' : 'pending') as TimelineStep['state'],
    }))
  }

  const currentIndex = mainFlowOrder.indexOf(s)
  return mainFlowOrder.map((step, i) => ({
    id: step,
    label: stepMeta[step]?.label ?? step,
    date: stepMeta[step]?.date ?? null,
    state: (i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'pending') as TimelineStep['state'],
  }))
}

/**
 * RSC entry point for the client order detail page.
 *
 * Route: /dashboard/orders/[orderId]
 * Auth:  CLIENT role only; redirects to /auth/signin otherwise.
 * Guard: notFound() for missing orders and orders owned by another client —
 *        both branches produce 404 to prevent information leakage.
 */
export default async function OrderDetailPage({
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
      service: { select: { name: true, pricingMode: true } },
      lab:     { select: { name: true } },
      clientProfile: true,
    },
  })

  if (!order) notFound()
  if (order.clientId !== session.user.id) notFound()

  const dto: OrderDetailDTO = {
    id: order.id,
    status: order.status,
    pricingMode: order.service.pricingMode,
    serviceName: order.service.name,
    labName: order.lab.name,
    quotedPrice: order.quotedPrice != null ? order.quotedPrice.toFixed(2) : null,
    createdAt: order.createdAt.toISOString(),
    quotedAt: order.quotedAt?.toISOString() ?? null,
    paidAt: order.paidAt?.toISOString() ?? null,
    clientName: order.clientProfile?.name ?? null,
    clientEmail: order.clientProfile?.email ?? null,
    clientPhone: order.clientProfile?.phone ?? null,
    clientOrganization: order.clientProfile?.organization ?? null,
    clientAddress: order.clientProfile?.address ?? null,
    quantity: order.quantity,
    notes: order.notes ?? null,
  }

  const badge = statusBadgeConfig[dto.status as OrderStatus] ??
    { label: dto.status, className: 'bg-gray-100 text-gray-500' }

  const timelineSteps = getTimelineSteps(dto.status, dto.pricingMode, dto.createdAt, dto.quotedAt, dto.paidAt)

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">

        <div className="mb-4">
          <a href="/dashboard/client" className="text-sm text-blue-600 hover:underline">
            ← Back to dashboard
          </a>
        </div>

        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">
            Order{' '}
            <span className="font-mono text-lg">{dto.id.slice(0, 8)}…</span>
          </h1>
        </div>

        {/* Order Summary */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Order Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-gray-100 text-sm">
              <div className="flex justify-between py-2">
                <dt className="text-gray-500">Status</dt>
                <dd>
                  <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}>
                    {badge.label}
                  </span>
                </dd>
              </div>
              <div className="flex justify-between py-2">
                <dt className="text-gray-500">Service</dt>
                <dd className="text-gray-900">{dto.serviceName}</dd>
              </div>
              <div className="flex justify-between py-2">
                <dt className="text-gray-500">Lab</dt>
                <dd className="text-gray-900">{dto.labName}</dd>
              </div>
              <div className="flex justify-between py-2">
                <dt className="text-gray-500">Amount</dt>
                <dd className="text-gray-900">
                  {dto.quotedPrice != null ? `₱${dto.quotedPrice}` : 'Not yet quoted'}
                </dd>
              </div>
              <div className="flex justify-between py-2">
                <dt className="text-gray-500">Quantity</dt>
                <dd className="text-gray-900">{dto.quantity}</dd>
              </div>
              <div className="flex justify-between py-2">
                <dt className="text-gray-500">Submitted</dt>
                <dd className="text-gray-900">{new Date(dto.createdAt).toLocaleDateString()}</dd>
              </div>
              {dto.notes != null && (
                <div className="flex justify-between py-2">
                  <dt className="text-gray-500">Notes</dt>
                  <dd className="text-gray-900 max-w-xs text-right">{dto.notes}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>

        {/* Contact Details */}
        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Contact Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y divide-gray-100 text-sm">
              <div className="flex justify-between py-2">
                <dt className="text-gray-500">Name</dt>
                <dd className="text-gray-900">{dto.clientName ?? 'Not provided'}</dd>
              </div>
              <div className="flex justify-between py-2">
                <dt className="text-gray-500">Email</dt>
                <dd className="text-gray-900">{dto.clientEmail ?? 'Not provided'}</dd>
              </div>
              <div className="flex justify-between py-2">
                <dt className="text-gray-500">Phone</dt>
                <dd className="text-gray-900">{dto.clientPhone ?? 'Not provided'}</dd>
              </div>
              {dto.clientOrganization != null && (
                <div className="flex justify-between py-2">
                  <dt className="text-gray-500">Organization</dt>
                  <dd className="text-gray-900">{dto.clientOrganization}</dd>
                </div>
              )}
              {dto.clientAddress != null && (
                <div className="flex justify-between py-2">
                  <dt className="text-gray-500">Address</dt>
                  <dd className="text-gray-900 max-w-xs text-right">{dto.clientAddress}</dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>

        {/* Status Timeline */}
        <Card>
          <CardHeader>
            <CardTitle>Status Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="relative ml-3">
              {timelineSteps.map((step, i) => {
                const isLast = i === timelineSteps.length - 1
                return (
                  <li key={step.id} className="relative pl-8 pb-6 last:pb-0">
                    {/* Connector line */}
                    {!isLast && (
                      <div className="absolute left-[9px] top-5 h-full w-0.5 bg-gray-200" />
                    )}
                    {/* Step indicator */}
                    <div className={`absolute left-0 top-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 ${
                      step.state === 'done'    ? 'border-green-500 bg-green-500' :
                      step.state === 'current' ? 'border-blue-500 bg-blue-500'  :
                                                 'border-gray-300 bg-white'
                    }`}>
                      {step.state === 'done' && (
                        <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 12 12">
                          <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                      {step.state === 'current' && (
                        <div className="h-2 w-2 rounded-full bg-white" />
                      )}
                    </div>
                    {/* Step label */}
                    <div className="flex items-baseline justify-between">
                      <p className={`text-sm font-medium ${
                        step.state === 'done'    ? 'text-gray-900' :
                        step.state === 'current' ? 'text-blue-700' :
                                                   'text-gray-400'
                      }`}>
                        {step.label}
                      </p>
                      {step.date != null && (
                        <p className="ml-4 text-xs text-gray-400">
                          {new Date(step.date).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          </CardContent>
        </Card>

      </div>
    </div>
  )
}
