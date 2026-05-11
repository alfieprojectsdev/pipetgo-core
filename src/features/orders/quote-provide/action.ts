'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { OrderStatus, Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { isValidStatusTransition } from '@/domain/orders/state-machine'

type ActionState = { message?: string } | null

export async function provideQuote(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const orderId = formData.get('orderId') as string | null
  const priceRaw = formData.get('price') as string | null

  if (!orderId) return { message: 'Missing order ID.' }
  if (!priceRaw) return { message: 'Missing price.' }

  const n = Number(priceRaw)
  if (!Number.isFinite(n) || n <= 0) return { message: 'Price must be a positive number.' }

  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
    return { message: 'Unauthorized.' }
  }

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { lab: true },
    })

    if (!order || !order.lab || order.lab.ownerId !== session.user.id) {
      return { message: 'Order not found.' }
    }
    if (!isValidStatusTransition(order.status, OrderStatus.QUOTE_PROVIDED)) {
      return { message: 'Order cannot be transitioned to QUOTE_PROVIDED from current status.' }
    }

    await tx.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.QUOTE_PROVIDED,
        quotedPrice: new Prisma.Decimal(priceRaw),
        quotedAt: new Date(),
      },
    })

    return null
  })

  if (result !== null) return result

  revalidatePath('/dashboard/lab')
  return null
}

export async function cancelOrder(
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const orderId = formData.get('orderId') as string | null
  if (!orderId) return { message: 'Missing order ID.' }

  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
    return { message: 'Unauthorized.' }
  }

  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { lab: true },
    })

    if (!order || !order.lab || order.lab.ownerId !== session.user.id) {
      return { message: 'Order not found.' }
    }
    if (!isValidStatusTransition(order.status, OrderStatus.CANCELLED)) {
      return { message: 'Order cannot be cancelled from current status.' }
    }

    await tx.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.CANCELLED },
    })

    return null
  })

  if (result !== null) return result

  revalidatePath('/dashboard/lab')
  redirect('/dashboard/lab')
}
