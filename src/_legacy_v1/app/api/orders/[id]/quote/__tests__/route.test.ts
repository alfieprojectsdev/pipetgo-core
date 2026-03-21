import { describe, it, expect, beforeEach, vi } from 'vitest'
import { POST } from '../route'
import { getServerSession } from 'next-auth'
import { prisma } from '@/lib/db'
import { NextRequest } from 'next/server'

// Mock NextAuth
vi.mock('next-auth', () => ({
  getServerSession: vi.fn()
}))

// Mock Prisma
vi.mock('@/lib/db', () => ({
  prisma: {
    order: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn()
    },
    $transaction: vi.fn()
  }
}))

describe('POST /api/orders/[id]/quote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Authentication & Authorization', () => {
    it('should reject unauthenticated requests', async () => {
      vi.mocked(getServerSession).mockResolvedValue(null)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/quote', {
        method: 'POST',
        body: JSON.stringify({ quotedPrice: 5000 })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(401)
      expect(data.error).toBe('Unauthorized')
    })

    it('should reject non-LAB_ADMIN users', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/quote', {
        method: 'POST',
        body: JSON.stringify({ quotedPrice: 5000 })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(403)
      expect(data.error).toBe('Only lab administrators can provide quotes')
    })

    it('should reject LAB_ADMIN who does not own the lab', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'lab-admin-1', role: 'LAB_ADMIN', email: 'admin@lab1.com' }
      } as any)

      // Order exists but belongs to different lab
      vi.mocked(prisma.order.findFirst).mockResolvedValue(null)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/quote', {
        method: 'POST',
        body: JSON.stringify({ quotedPrice: 5000 })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(404)
      expect(data.error).toBe('Order not found or access denied')

      // Verify ownership check in query
      expect(prisma.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'order-1',
            lab: { ownerId: 'lab-admin-1' }  // Ownership verification
          })
        })
      )
    })
  })

  describe('State Machine Validation', () => {
    it('should reject quote provision if order not in QUOTE_REQUESTED status', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'lab-admin-1', role: 'LAB_ADMIN', email: 'admin@lab1.com' }
      } as any)

      // Order exists, owned by correct lab, but already has quote
      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        id: 'order-1',
        status: 'QUOTE_PROVIDED',  // Already quoted
        labId: 'lab-1',
        clientId: 'client-1',
        serviceId: 'service-1',
        lab: { id: 'lab-1', ownerId: 'lab-admin-1' }
      } as any)

      // Mock transaction to simulate race condition check
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
        // Mock updateMany returning 0 (no rows updated because status doesn't match)
        vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 0 } as any)

        // Mock findUnique returning order with current status
        vi.mocked(prisma.order.findUnique).mockResolvedValue({
          id: 'order-1',
          status: 'QUOTE_PROVIDED'
        } as any)

        return callback(prisma)
      })

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/quote', {
        method: 'POST',
        body: JSON.stringify({ quotedPrice: 5000 })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(409)
      expect(data.error).toContain('Quote already provided')
      expect(data.error).toContain('QUOTE_PROVIDED')
    })
  })

  describe('Successful Quote Provision', () => {
    it('should successfully provide quote with all fields', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'lab-admin-1', role: 'LAB_ADMIN', email: 'admin@lab1.com' }
      } as any)

      const mockOrder = {
        id: 'order-1',
        status: 'QUOTE_REQUESTED',
        labId: 'lab-1',
        clientId: 'client-1',
        serviceId: 'service-1',
        quotedPrice: null,
        quotedAt: null,
        lab: { id: 'lab-1', ownerId: 'lab-admin-1', name: 'Test Lab' },
        client: { id: 'client-1', name: 'Test Client', email: 'client@test.com' },
        service: { id: 'service-1', name: 'pH Testing' }
      }

      vi.mocked(prisma.order.findFirst).mockResolvedValue(mockOrder as any)

      const updatedOrder = {
        ...mockOrder,
        quotedPrice: 5000,
        quotedAt: new Date(),
        quoteNotes: 'Standard analysis for water sample',
        estimatedTurnaroundDays: 5,
        status: 'QUOTE_PROVIDED'
      }

      // Mock transaction to return updated order
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
        // Mock updateMany returning 1 (success)
        vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 1 } as any)

        // Mock findUnique returning updated order
        vi.mocked(prisma.order.findUnique).mockResolvedValue(updatedOrder as any)

        return callback(prisma)
      })

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/quote', {
        method: 'POST',
        body: JSON.stringify({
          quotedPrice: 5000,
          quoteNotes: 'Standard analysis for water sample',
          estimatedTurnaroundDays: 5
        })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.quotedPrice).toBe(5000)
      expect(data.status).toBe('QUOTE_PROVIDED')
      expect(data.quoteNotes).toBe('Standard analysis for water sample')
      expect(data.estimatedTurnaroundDays).toBe(5)

      // Verify updateMany was called with atomic check
      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'order-1',
            status: 'QUOTE_REQUESTED'  // Atomic status check
          }),
          data: expect.objectContaining({
            quotedPrice: 5000,
            quotedAt: expect.any(Date),
            quoteNotes: 'Standard analysis for water sample',
            estimatedTurnaroundDays: 5,
            status: 'QUOTE_PROVIDED'
          })
        })
      )
    })

    it('should successfully provide quote with only required fields', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'lab-admin-1', role: 'LAB_ADMIN', email: 'admin@lab1.com' }
      } as any)

      const mockOrder = {
        id: 'order-2',
        status: 'QUOTE_REQUESTED',
        labId: 'lab-1',
        lab: { id: 'lab-1', ownerId: 'lab-admin-1' }
      }

      vi.mocked(prisma.order.findFirst).mockResolvedValue(mockOrder as any)

      const updatedOrder = {
        ...mockOrder,
        quotedPrice: 1500,
        quotedAt: new Date(),
        status: 'QUOTE_PROVIDED'
      }

      // Mock transaction
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
        vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 1 } as any)
        vi.mocked(prisma.order.findUnique).mockResolvedValue(updatedOrder as any)
        return callback(prisma)
      })

      const request = new NextRequest('http://localhost:3000/api/orders/order-2/quote', {
        method: 'POST',
        body: JSON.stringify({ quotedPrice: 1500 })
      })

      const response = await POST(request, { params: { id: 'order-2' } })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.quotedPrice).toBe(1500)
      expect(data.status).toBe('QUOTE_PROVIDED')
    })
  })

  describe('Validation Errors', () => {
    beforeEach(() => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'lab-admin-1', role: 'LAB_ADMIN', email: 'admin@lab1.com' }
      } as any)

      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        id: 'order-1',
        status: 'QUOTE_REQUESTED',
        lab: { ownerId: 'lab-admin-1' }
      } as any)
    })

    it('should reject negative price', async () => {
      const request = new NextRequest('http://localhost:3000/api/orders/order-1/quote', {
        method: 'POST',
        body: JSON.stringify({ quotedPrice: -100 })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Validation error')
      expect(data.details).toBeDefined()
    })

    it('should reject price exceeding maximum (₱1,000,000)', async () => {
      const request = new NextRequest('http://localhost:3000/api/orders/order-1/quote', {
        method: 'POST',
        body: JSON.stringify({ quotedPrice: 1000001 })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Validation error')
    })

    it('should reject notes exceeding 500 characters', async () => {
      const request = new NextRequest('http://localhost:3000/api/orders/order-1/quote', {
        method: 'POST',
        body: JSON.stringify({
          quotedPrice: 5000,
          quoteNotes: 'A'.repeat(501)
        })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Validation error')
    })

    it('should reject decimal turnaround days (must be whole days)', async () => {
      const request = new NextRequest('http://localhost:3000/api/orders/order-1/quote', {
        method: 'POST',
        body: JSON.stringify({
          quotedPrice: 5000,
          estimatedTurnaroundDays: 3.5
        })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Validation error')
    })
  })
})
