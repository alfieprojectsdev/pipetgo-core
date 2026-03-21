import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { requestCustomQuoteSchema } from '@/lib/validations/quote'
import { z } from 'zod'

/**
 * POST /api/orders/[id]/request-custom-quote
 * Client requests custom quote for HYBRID service initially booked at fixed rate
 *
 * Authorization: CLIENT only, must own the order
 * Pricing mode requirement: Service must have pricingMode = HYBRID
 * State requirement: Order status must be PENDING
 *
 * Use case: Client initially booked HYBRID service at reference price, but now
 * wants custom quote (e.g., bulk discount, special handling, urgent turnaround)
 *
 * @example
 * POST /api/orders/order-123/request-custom-quote
 * Body: { reason: "Need bulk discount for 50+ samples" }
 * Response: { id: "order-123", quotedPrice: null, status: "QUOTE_REQUESTED", ... }
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
        { error: 'Only clients can request custom quotes' },
        { status: 403 }
      )
    }

    // 3. Fetch order with ownership verification + service pricing mode
    const order = await prisma.order.findFirst({
      where: {
        id: params.id,
        clientId: session.user.id  // Verify order belongs to this client
      },
      include: {
        service: {
          select: { id: true, name: true, pricingMode: true }
        },
        lab: { select: { id: true, name: true } },
        client: { select: { id: true, name: true, email: true } }
      }
    })

    if (!order) {
      // Return 404 for both non-existent orders AND orders not owned by this client
      return NextResponse.json(
        { error: 'Order not found or access denied' },
        { status: 404 }
      )
    }

    // 4. Pricing mode validation: Only HYBRID services support custom quote requests
    if (order.service.pricingMode !== 'HYBRID') {
      return NextResponse.json(
        {
          error: `Custom quote requests are only available for HYBRID pricing mode services (current: ${order.service.pricingMode})`
        },
        { status: 400 }
      )
    }

    // 5. State machine validation: Can only request custom quote for PENDING orders
    // (PENDING = initially booked at fixed rate, not yet acknowledged by lab)
    if (order.status !== 'PENDING') {
      return NextResponse.json(
        {
          error: `You can only request custom quote for orders with status PENDING (current: ${order.status})`
        },
        { status: 400 }
      )
    }

    // 6. Parse and validate request body
    const body = await request.json()
    const validatedData = requestCustomQuoteSchema.parse(body)

    // 7. Update order: Reset pricing, transition to QUOTE_REQUESTED, append reason
    const updatedSpecialInstructions = order.specialInstructions
      ? `${order.specialInstructions}\n\nCustom Quote Requested: ${validatedData.reason}`
      : `Custom Quote Requested: ${validatedData.reason}`

    const updatedOrder = await prisma.order.update({
      where: { id: params.id },
      data: {
        quotedPrice: null,        // Reset to null (awaiting lab's custom quote)
        quotedAt: null,           // Clear timestamp
        status: 'QUOTE_REQUESTED',  // Transition back to quote workflow
        specialInstructions: updatedSpecialInstructions
      },
      include: {
        service: { select: { name: true, category: true, pricingMode: true } },
        lab: { select: { name: true } },
        client: { select: { name: true, email: true } },
        attachments: true
      }
    })

    // TODO (Phase 5): Send notification to lab admin about custom quote request

    return NextResponse.json(updatedOrder, { status: 200 })

  } catch (error) {
    console.error('Error requesting custom quote:', error)

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation error', details: error.errors },
        { status: 400 }
      )
    }

    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
