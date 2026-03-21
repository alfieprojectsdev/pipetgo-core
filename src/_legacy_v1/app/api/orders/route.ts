import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { analytics } from '@/lib/analytics'
import { OrderStatus } from '@prisma/client'
import { z } from 'zod'

const createOrderSchema = z.object({
  serviceId: z.string(),
  sampleDescription: z.string().min(10),
  specialInstructions: z.string().optional(),
  requestCustomQuote: z.boolean().optional(), // For HYBRID mode
  clientDetails: z.object({
    contactEmail: z.string().email(),
    contactPhone: z.string().optional(),
    shippingAddress: z.object({
      street: z.string(),
      city: z.string(),
      postal: z.string(),
      country: z.string().default('Philippines')
    }),
    organization: z.string().optional()
  })
})

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session || session.user.role !== 'CLIENT') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const validatedData = createOrderSchema.parse(body)

    // Get service and lab details
    const service = await prisma.labService.findUnique({
      where: { id: validatedData.serviceId },
      include: { lab: true }
    })

    if (!service || !service.active) {
      return NextResponse.json({ error: 'Service not found' }, { status: 404 })
    }

    // Determine initial order status and pricing based on service pricing mode
    let initialStatus: 'QUOTE_REQUESTED' | 'PENDING'
    let quotedPrice: number | null
    let quotedAt: Date | null

    if (service.pricingMode === 'QUOTE_REQUIRED') {
      // QUOTE_REQUIRED: Always requires custom quote from lab
      initialStatus = 'QUOTE_REQUESTED'
      quotedPrice = null
      quotedAt = null

    } else if (service.pricingMode === 'FIXED') {
      // FIXED: Auto-populate with fixed price, skip quote workflow
      initialStatus = 'PENDING'
      quotedPrice = service.pricePerUnit ? Number(service.pricePerUnit) : null
      quotedAt = new Date()

    } else if (service.pricingMode === 'HYBRID') {
      // HYBRID: Client chooses instant booking OR custom quote
      if (validatedData.requestCustomQuote === true) {
        // Client requested custom quote
        initialStatus = 'QUOTE_REQUESTED'
        quotedPrice = null
        quotedAt = null
      } else {
        // Client accepted reference price (instant booking)
        initialStatus = 'PENDING'
        quotedPrice = service.pricePerUnit ? Number(service.pricePerUnit) : null
        quotedAt = new Date()
      }

    } else {
      // Fallback: Default to quote-required (safety)
      initialStatus = 'QUOTE_REQUESTED'
      quotedPrice = null
      quotedAt = null
    }

    const order = await prisma.order.create({
      data: {
        clientId: session.user.id,
        labId: service.labId,
        serviceId: service.id,
        status: initialStatus,
        sampleDescription: validatedData.sampleDescription,
        specialInstructions: validatedData.specialInstructions,
        clientDetails: validatedData.clientDetails,
        quotedPrice,
        quotedAt,
      },
      include: {
        service: true,
        lab: { select: { name: true } },
        client: { select: { name: true, email: true } }
      }
    })

    // Analytics: Track quote request if applicable
    if (initialStatus === 'QUOTE_REQUESTED') {
      analytics.quoteRequested()
    }

    // Analytics: Track order creation with pricing mode
    analytics.orderCreated(service.pricingMode)

    return NextResponse.json(order, { status: 201 })
  } catch (error) {
    console.error('Error creating order:', error)
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

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const searchParams = request.nextUrl.searchParams
    const status = searchParams.get('status')

    const whereClause: {
      clientId?: string
      lab?: { ownerId: string }
      status?: OrderStatus
    } = {}

    // Filter based on user role
    if (session.user.role === 'CLIENT') {
      whereClause.clientId = session.user.id
    } else if (session.user.role === 'LAB_ADMIN') {
      // Single query with nested where - Prisma generates optimized JOIN
      whereClause.lab = {
        ownerId: session.user.id
      }
    }
    // ADMIN can see all orders (no additional filter)

    if (status) {
      whereClause.status = status as OrderStatus
    }

    const orders = await prisma.order.findMany({
      where: whereClause,
      include: {
        service: { select: { name: true, category: true } },
        lab: { select: { name: true } },
        client: { select: { name: true, email: true } },
        attachments: true
      },
      orderBy: { createdAt: 'desc' }
    })

    return NextResponse.json(orders)
  } catch (error) {
    console.error('Error fetching orders:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}