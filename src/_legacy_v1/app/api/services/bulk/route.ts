import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { z } from 'zod'

const bulkActionSchema = z.object({
  serviceIds: z.array(z.string().cuid()).min(1, 'At least one service must be selected'),
  action: z.enum(['enable', 'disable'])
})

/**
 * POST /api/services/bulk
 *
 * Bulk enable or disable multiple lab services.
 *
 * @requires LAB_ADMIN role
 * @requires All services must belong to the authenticated user's lab
 *
 * @body serviceIds - Array of service IDs to update
 * @body action - 'enable' or 'disable'
 *
 * @returns Message with count of services affected
 *
 * @example
 * POST /api/services/bulk
 * {
 *   "serviceIds": ["clx123abc", "clx456def"],
 *   "action": "enable"
 * }
 *
 * Response:
 * {
 *   "message": "2 services enabled",
 *   "count": 2
 * }
 */
export async function POST(req: Request) {
  try {
    // 1. Authentication
    const session = await getServerSession(authOptions)

    if (!session?.user || session.user.role !== 'LAB_ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // 2. Get lab ownership
    const lab = await prisma.lab.findFirst({
      where: { ownerId: session.user.id }
    })

    if (!lab) {
      return NextResponse.json({ error: 'Lab not found' }, { status: 404 })
    }

    // 3. Validate request body
    const body = await req.json()
    const { serviceIds, action } = bulkActionSchema.parse(body)

    // 4. Verify all services belong to user's lab
    const services = await prisma.labService.findMany({
      where: {
        id: { in: serviceIds },
        labId: lab.id  // CRITICAL: Ownership check
      },
      select: { id: true }
    })

    if (services.length !== serviceIds.length) {
      return NextResponse.json(
        { error: 'Some services not found or access denied' },
        { status: 403 }
      )
    }

    // 5. Perform bulk update
    const result = await prisma.labService.updateMany({
      where: {
        id: { in: serviceIds },
        labId: lab.id
      },
      data: {
        active: action === 'enable'
      }
    })

    return NextResponse.json({
      message: `${result.count} service${result.count > 1 ? 's' : ''} ${action === 'enable' ? 'enabled' : 'disabled'}`,
      count: result.count
    })

  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', details: error.errors },
        { status: 400 }
      )
    }

    console.error('Bulk operation error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
