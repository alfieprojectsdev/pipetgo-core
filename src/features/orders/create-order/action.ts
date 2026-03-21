'use server'

import { redirect } from 'next/navigation'
import { OrderStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { clientDetailsSchema } from '@/domain/orders/client-details'
import { resolveOrderInitialState } from '@/domain/orders/pricing'

type ActionState = {
  errors?: Partial<Record<string, string[]>>
  message?: string
} | null

export async function createOrder(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const serviceId = formData.get('serviceId') as string | null
  if (!serviceId) return { message: 'Missing service ID.' }

  // Re-fetch from DB — do not trust any pricingMode value from the client (TOCTOU guard)
  const service = await prisma.labService.findUnique({
    where: { id: serviceId, isActive: true },
  })
  if (!service) return { message: 'Service no longer available.' }

  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
    return { message: 'Unauthorized.' }
  }
  const userId = session.user.id

  const rawDetails = {
    name: formData.get('name'),
    email: formData.get('email'),
    phone: formData.get('phone'),
    organization: formData.get('organization') || undefined,
    address: formData.get('address') || undefined,
  }
  const parsed = clientDetailsSchema.safeParse(rawDetails)
  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }

  const rawSampleDescription = formData.get('sampleDescription')
  if (!rawSampleDescription || typeof rawSampleDescription !== 'string') {
    return { errors: { sampleDescription: ['Sample description is required.'] } }
  }
  const sampleDescription = rawSampleDescription.trim()
  const specialInstructions = (formData.get('specialInstructions') as string | null)?.trim()
  const notes = specialInstructions
    ? `${sampleDescription}\n\n${specialInstructions}`
    : sampleDescription

  // HYBRID only: carried as a hidden input string, not a checkbox presence check
  const requestCustomQuote =
    service.pricingMode === 'HYBRID'
      ? formData.get('requestCustomQuote') === 'true'
      : undefined

  const initialState = resolveOrderInitialState(service, requestCustomQuote)

  // Note: isValidStatusTransition() applies to status mutations on existing orders only.
  // Initial creation has no from-status; resolveOrderInitialState() is the domain gate
  // for the initial status (ref: domain invariant DL-009, README.md invariant).
  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.order.create({
      data: {
        clientId: userId,
        labId: service.labId,
        serviceId: service.id,
        status: initialState.status,
        quantity: 1, // One sample per order — multi-sample is a separate slice with different pricing
        notes,
        quotedPrice: initialState.quotedPrice,
        quotedAt: initialState.quotedAt,
      },
    })
    await tx.clientProfile.create({
      data: {
        orderId: created.id,
        name: parsed.data.name,
        email: parsed.data.email,
        phone: parsed.data.phone,
        organization: parsed.data.organization,
        address: parsed.data.address,
      },
    })
    return created
  })

  if (order.status === OrderStatus.PAYMENT_PENDING) {
    redirect(`/dashboard/orders/${order.id}/pay`)
  }
  redirect('/dashboard/client')
}
