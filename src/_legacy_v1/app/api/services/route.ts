import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { createServiceSchema } from '@/lib/validations/service'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const DEFAULT_PAGE_SIZE = 12
const MAX_PAGE_SIZE = 50

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams

    // Parse pagination params
    const page = Math.max(1, parseInt(searchParams.get('page') || '1'))
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseInt(searchParams.get('pageSize') || String(DEFAULT_PAGE_SIZE)))
    )
    const skip = (page - 1) * pageSize

    // Parse filter params
    const category = searchParams.get('category')
    const search = searchParams.get('search')
    const format = searchParams.get('format') // 'legacy' or null
    const labId = searchParams.get('labId')
    const activeFilter = searchParams.get('active') // 'all' to include inactive services

    // Build where clause
    const where = {
      ...(activeFilter !== 'all' && { active: true }), // Default: only active services
      ...(category && { category }),
      ...(labId && { labId }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' as const } },
          { description: { contains: search, mode: 'insensitive' as const } },
        ]
      })
    }

    // Execute queries in parallel
    const [items, totalCount] = await Promise.all([
      prisma.labService.findMany({
        where,
        include: {
          lab: {
            select: {
              id: true,
              name: true,
              location: true,
              certifications: true,
            }
          }
        },
        orderBy: {
          createdAt: 'desc'
        },
        skip,
        take: pageSize,
      }),
      prisma.labService.count({ where })
    ])

    const totalPages = Math.ceil(totalCount / pageSize)

    // Backward compatibility
    if (format === 'legacy') {
      return NextResponse.json(items)
    }

    return NextResponse.json({
      items,
      pagination: {
        page,
        pageSize,
        totalCount,
        totalPages,
        hasMore: page < totalPages
      }
    })
  } catch (error) {
    console.error('Error fetching services:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function POST(req: Request) {
  try {
    // 1. Authentication check
    const session = await getServerSession(authOptions)

    if (!session?.user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // 2. Role verification
    if (session.user.role !== 'LAB_ADMIN') {
      return NextResponse.json(
        { error: 'Only lab administrators can create services' },
        { status: 403 }
      )
    }

    // 3. Lab ownership verification
    const lab = await prisma.lab.findFirst({
      where: { ownerId: session.user.id }
    })

    if (!lab) {
      return NextResponse.json(
        { error: 'Lab not found' },
        { status: 404 }
      )
    }

    // 4. Parse and validate request body
    const body = await req.json()
    const validatedData = createServiceSchema.parse(body)

    // 5. Create service
    const service = await prisma.labService.create({
      data: {
        ...validatedData,
        labId: lab.id  // Use lab.id from ownership check, never trust request body
      }
    })

    return NextResponse.json(service, { status: 201 })

  } catch (error) {
    // Zod validation error
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: 'Validation failed',
          details: error.errors
        },
        { status: 400 }
      )
    }

    // Generic error
    console.error('Service creation error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
