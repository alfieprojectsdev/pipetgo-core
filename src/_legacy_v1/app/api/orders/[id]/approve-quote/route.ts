import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { approveQuoteSchema } from '@/lib/validations/quote'
import { analytics } from '@/lib/analytics'
import { z } from 'zod'

/**
 * POST /api/orders/[id]/approve-quote
 * Client approves or rejects lab's custom quote
 *
 * Authorization: CLIENT only, must own the order
 * State requirement: Order status must be QUOTE_PROVIDED
 *
 * @example
 * // Approve quote
 * POST /api/orders/order-123/approve-quote
 * Body: { approved: true }
 * Response: { id: "order-123", status: "PENDING", quoteApprovedAt: "2025-11-01T12:00:00Z", ... }
 *
 * @example
 * // Reject quote
 * POST /api/orders/order-123/approve-quote
 * Body: { approved: false, rejectionReason: "Price exceeds our budget" }
 * Response: { id: "order-123", status: "QUOTE_REJECTED", rejectionReason: "...", quoteRejectedAt: "...", ... }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // 1. Authentication check
    const session = await getServerSession(authOptions)
    if (!session || !session.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // 2. Role verification (CLIENT only)
    if (session.user.role !== 'CLIENT') {
      return NextResponse.json(
        { error: 'Only clients can approve or reject quotes' },
        { status: 403 }
      )
    }

    // 3. Fetch order with ownership verification
    // Combines resource lookup + ownership check in single query (security best practice)
    const order = await prisma.order.findFirst({
      where: {
        id: params.id,
        clientId: session.user.id  // Verify order belongs to this client
      },
      include: {
        lab: { select: { id: true, name: true } },
        client: { select: { id: true, name: true, email: true } },
        service: { select: { id: true, name: true } }
      }
    })

    if (!order) {
      // Return 404 for both non-existent orders AND orders not owned by this client
      // (Don't leak existence of orders via 403 vs 404)
      return NextResponse.json(
        { error: 'Order not found or access denied' },
        { status: 404 }
      )
    }

    // 4. Parse and validate request body
    const body = await request.json()
    const validatedData = approveQuoteSchema.parse(body)

    // 5. Update order based on approval decision using transaction (P0-2, P0-3)
    // Use atomic updateMany to prevent race condition + ensure data integrity
    const updateData = validatedData.approved
      ? {
          // Quote approved: Transition to PENDING (ready for lab to acknowledge)
          status: 'PENDING' as const,
          quoteApprovedAt: new Date(),
          quoteRejectedReason: null  // Clear any previous rejection reason
        }
      : {
          // Quote rejected: Transition to QUOTE_REJECTED
          status: 'QUOTE_REJECTED' as const,
          quoteRejectedReason: validatedData.rejectionReason,
          quoteRejectedAt: new Date()
        }

    const result = await prisma.$transaction(async (tx) => {
      // Atomic update - only succeeds if status is QUOTE_PROVIDED
      const updateResult = await tx.order.updateMany({
        where: {
          id: params.id,
          status: 'QUOTE_PROVIDED'  // ✅ Atomic check + update (prevents race condition)
        },
        data: updateData
      })

      // Check if update actually happened
      if (updateResult.count === 0) {
        const order = await tx.order.findUnique({
          where: { id: params.id },
          select: { status: true }
        })

        if (!order) {
          throw new Error('ORDER_NOT_FOUND')
        }

        throw new Error(`INVALID_STATUS:${order.status}`)
      }

      // Fetch updated order with includes
      const updatedOrder = await tx.order.findUnique({
        where: { id: params.id },
        include: {
          service: { select: { name: true, category: true } },
          lab: { select: { name: true, ownerId: true } },
          client: { select: { name: true, email: true } },
          attachments: true
        }
      })

      // TODO (Future): Create notification in same transaction
      // await tx.notification.create({
      //   data: {
      //     userId: updatedOrder.lab.ownerId,
      //     type: validatedData.approved ? 'QUOTE_APPROVED' : 'QUOTE_REJECTED',
      //     orderId: updatedOrder.id
      //   }
      // })

      return updatedOrder
    })

    // Analytics: Track quote approval (not rejection)
    if (validatedData.approved) {
      analytics.quoteApproved()
    }

    return NextResponse.json(result, { status: 200 })

  } catch (error) {
    console.error('Error approving/rejecting quote:', error)

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.errors },
        { status: 400 }
      )
    }

    // Handle transaction errors
    if (error instanceof Error) {
      if (error.message === 'ORDER_NOT_FOUND') {
        return NextResponse.json({ error: 'Order not found' }, { status: 404 })
      }

      if (error.message.startsWith('INVALID_STATUS:')) {
        const currentStatus = error.message.split(':')[1]
        return NextResponse.json(
          { error: `Quote can only be approved/rejected when status is QUOTE_PROVIDED (current status: ${currentStatus})` },
          { status: 409 }
        )
      }
    }

    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
