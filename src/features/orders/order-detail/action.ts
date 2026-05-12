'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { OrderStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { isValidStatusTransition } from '@/domain/orders/state-machine'

type ActionState = { message?: string } | null

export async function acceptQuote(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const orderId = formData.get('orderId') as string | null
  if (!orderId) return { message: 'Missing order ID.' }

  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
    return { message: 'Unauthorized.' }
  }

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
    })

    if (!order || order.clientId !== session.user.id) {
      return { message: 'Order not found.' }
    }
    if (!isValidStatusTransition(order.status, OrderStatus.PAYMENT_PENDING)) {
      return { message: 'Order cannot be accepted from current status.' }
    }

    await tx.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.PAYMENT_PENDING },
    })

    return null
  })

  if (result !== null) return result

  redirect(`/dashboard/orders/${orderId}/pay`)
}

export async function rejectQuote(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const orderId = formData.get('orderId') as string | null
  if (!orderId) return { message: 'Missing order ID.' }

  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
    return { message: 'Unauthorized.' }
  }

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
    })

    if (!order || order.clientId !== session.user.id) {
      return { message: 'Order not found.' }
    }
    if (!isValidStatusTransition(order.status, OrderStatus.QUOTE_REJECTED)) {
      return { message: 'Order cannot be rejected from current status.' }
    }

    await tx.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.QUOTE_REJECTED },
    })

    return null
  })

  if (result !== null) return result

  revalidatePath(`/dashboard/orders/${orderId}`)
  return null
}

// retryPayment: PAYMENT_FAILED→PAYMENT_PENDING transition only; no Xendit invoice created.
// Redirect goes to canonical checkout route /dashboard/orders/[orderId]/pay. (ref: DL-003, DL-004)
export async function retryPayment(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const orderId = formData.get('orderId') as string | null
  if (!orderId) return { message: 'Missing order ID.' }

  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
    return { message: 'Unauthorized.' }
  }

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
    })

    if (!order || order.clientId !== session.user.id) {
      return { message: 'Order not found.' }
    }
    if (!isValidStatusTransition(order.status, OrderStatus.PAYMENT_PENDING)) {
      return { message: 'Order cannot be retried from current status.' }
    }

    await tx.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.PAYMENT_PENDING },
    })

    return null
  })

  if (result !== null) return result

  redirect(`/dashboard/orders/${orderId}/pay`)
}
