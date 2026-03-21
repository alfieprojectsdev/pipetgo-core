import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { analytics } from '@/lib/analytics'
import { z } from 'zod'

const quoteSchema = z.object({
  quotedPrice: z.number().positive('Price must be positive').max(1000000, 'Price cannot exceed ₱1,000,000'),
  estimatedTurnaroundDays: z.number().int('Turnaround days must be a whole number').positive().optional(),
  quoteNotes: z.string().max(500, 'Notes cannot exceed 500 characters').optional()
})

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    // 1. Authentication check
    const session = await getServerSession(authOptions)

    if (!session?.user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // 2. Verify LAB_ADMIN role
    if (session.user.role !== 'LAB_ADMIN') {
      return NextResponse.json(
        { error: 'Only lab administrators can provide quotes' },
        { status: 403 }
      )
    }

    // 3. Parse and validate request body
    const body = await req.json()
    const validatedData = quoteSchema.parse(body)

    // 4. Fetch order with ownership check
    const order = await prisma.order.findFirst({
      where: {
        id: params.id,
        lab: {
          ownerId: session.user.id // ✅ Verify lab belongs to this user
        }
      },
      include: {
        lab: true,
        service: true,
        client: true
      }
    })

    if (!order) {
      return NextResponse.json(
        { error: 'Order not found or access denied' },
        { status: 404 }
      )
    }

    // 5. Update order with quote using transaction (P0-1, P0-3)
    // Use atomic updateMany to prevent race condition + ensure data integrity
    const result = await prisma.$transaction(async (tx) => {
      // Atomic update - only succeeds if status is QUOTE_REQUESTED
      const updateResult = await tx.order.updateMany({
        where: {
          id: params.id,
          status: 'QUOTE_REQUESTED'  // ✅ Atomic check + update (prevents race condition)
        },
        data: {
          quotedPrice: validatedData.quotedPrice,
          quotedAt: new Date(),
          status: 'QUOTE_PROVIDED',
          quoteNotes: validatedData.quoteNotes,
          estimatedTurnaroundDays: validatedData.estimatedTurnaroundDays
        }
      })

      // Check if update actually happened
      if (updateResult.count === 0) {
        // Either order doesn't exist OR status was already changed (race condition)
        const order = await tx.order.findUnique({
          where: { id: params.id },
          select: { status: true }
        })

        if (!order) {
          throw new Error('ORDER_NOT_FOUND')
        }

        throw new Error(`QUOTE_ALREADY_PROVIDED:${order.status}`)
      }

      // Fetch updated order with includes
      const updatedOrder = await tx.order.findUnique({
        where: { id: params.id },
        include: {
          service: true,
          lab: true,
          client: true
        }
      })

      // TODO (Future): Create notification record in same transaction
      // await tx.notification.create({
      //   data: {
      //     userId: updatedOrder.clientId,
      //     type: 'QUOTE_PROVIDED',
      //     orderId: updatedOrder.id
      //   }
      // })

      return updatedOrder
    })

    // Analytics: Track quote provided
    analytics.quoteProvided()

    return NextResponse.json(result, { status: 200 })

  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: 'Validation error',
          details: error.errors
        },
        { status: 400 }
      )
    }

    // Handle transaction errors
    if (error instanceof Error) {
      if (error.message === 'ORDER_NOT_FOUND') {
        return NextResponse.json({ error: 'Order not found' }, { status: 404 })
      }

      if (error.message.startsWith('QUOTE_ALREADY_PROVIDED:')) {
        const currentStatus = error.message.split(':')[1]
        return NextResponse.json(
          { error: `Quote already provided (current status: ${currentStatus})` },
          { status: 409 }  // 409 Conflict
        )
      }
    }

    console.error('Quote provision failed:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
