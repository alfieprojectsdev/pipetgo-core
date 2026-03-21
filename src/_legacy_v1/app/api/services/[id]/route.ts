import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { createServiceSchema } from '@/lib/validations/service'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

/**
 * GET /api/services/[id]
 * Fetch single service by ID
 *
 * Authorization: LAB_ADMIN only, must own the lab
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // 1. Authentication check
    const session = await getServerSession(authOptions)
    if (!session?.user || session.user.role !== 'LAB_ADMIN') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // 2. Verify service exists and user owns the lab
    const service = await prisma.labService.findFirst({
      where: {
        id: params.id,
        lab: {
          ownerId: session.user.id // Ownership verification
        }
      }
    })

    if (!service) {
      return NextResponse.json(
        { error: 'Service not found or access denied' },
        { status: 404 }
      )
    }

    return NextResponse.json(service)

  } catch (error) {
    console.error('Error fetching service:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * PATCH /api/services/[id]
 * Update service properties (active status toggle OR full service update)
 *
 * Authorization: LAB_ADMIN only, must own the lab
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // 1. Authentication check
    const session = await getServerSession(authOptions)
    if (!session?.user || session.user.role !== 'LAB_ADMIN') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // 2. Parse request body
    const body = await request.json()

    // 3. Verify service exists and user owns the lab
    const service = await prisma.labService.findFirst({
      where: {
        id: params.id,
        lab: {
          ownerId: session.user.id // Ownership verification
        }
      },
      include: {
        lab: {
          select: {
            id: true,
            name: true,
            ownerId: true
          }
        }
      }
    })

    if (!service) {
      return NextResponse.json(
        { error: 'Service not found or access denied' },
        { status: 404 }
      )
    }

    // 4. Determine update type: simple toggle OR full update
    const isSimpleToggle = Object.keys(body).length === 1 && 'active' in body

    if (isSimpleToggle) {
      // Simple active status toggle (existing behavior)
      if (typeof body.active !== 'boolean') {
        return NextResponse.json(
          { error: 'Invalid input: active must be a boolean' },
          { status: 400 }
        )
      }

      const updatedService = await prisma.labService.update({
        where: { id: params.id },
        data: { active: body.active },
        include: {
          lab: {
            select: {
              id: true,
              name: true
            }
          }
        }
      })

      return NextResponse.json(updatedService)
    } else {
      // Full service update with validation
      const validatedData = createServiceSchema.parse(body)

      const updatedService = await prisma.labService.update({
        where: { id: params.id },
        data: validatedData,
        include: {
          lab: {
            select: {
              id: true,
              name: true
            }
          }
        }
      })

      return NextResponse.json(updatedService)
    }

  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      )
    }

    console.error('Error updating service:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
