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

describe('POST /api/orders/[id]/approve-quote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Authentication & Authorization', () => {
    it('should reject unauthenticated requests', async () => {
      vi.mocked(getServerSession).mockResolvedValue(null)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/approve-quote', {
        method: 'POST',
        body: JSON.stringify({ approved: true })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(401)
      expect(data.error).toBe('Unauthorized')
    })

    it('should reject non-CLIENT users', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'lab-admin-1', role: 'LAB_ADMIN', email: 'admin@lab.com' }
      } as any)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/approve-quote', {
        method: 'POST',
        body: JSON.stringify({ approved: true })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(403)
      expect(data.error).toBe('Only clients can approve or reject quotes')
    })

    it('should reject CLIENT who does not own the order', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client1@test.com' }
      } as any)

      // Order exists but belongs to different client
      vi.mocked(prisma.order.findFirst).mockResolvedValue(null)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/approve-quote', {
        method: 'POST',
        body: JSON.stringify({ approved: true })
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
            clientId: 'client-1'  // Ownership verification
          })
        })
      )
    })
  })

  describe('State Machine Validation', () => {
    it('should reject approval if order not in QUOTE_PROVIDED status', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      // Order exists, owned by client, but no quote yet
      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        id: 'order-1',
        status: 'QUOTE_REQUESTED',  // Still waiting for quote
        clientId: 'client-1',
        labId: 'lab-1',
        serviceId: 'service-1'
      } as any)

      // Mock transaction to simulate race condition check
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
        // Mock updateMany returning 0 (no rows updated because status doesn't match)
        vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 0 } as any)

        // Mock findUnique returning order with current status
        vi.mocked(prisma.order.findUnique).mockResolvedValue({
          id: 'order-1',
          status: 'QUOTE_REQUESTED'
        } as any)

        return callback(prisma)
      })

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/approve-quote', {
        method: 'POST',
        body: JSON.stringify({ approved: true })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(409)
      expect(data.error).toContain('can only be approved/rejected when status is QUOTE_PROVIDED')
      expect(data.error).toContain('QUOTE_REQUESTED')
    })
  })

  describe('Quote Approval', () => {
    it('should successfully approve quote', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      const mockOrder = {
        id: 'order-1',
        status: 'QUOTE_PROVIDED',
        clientId: 'client-1',
        labId: 'lab-1',
        serviceId: 'service-1',
        quotedPrice: 5000,
        quotedAt: new Date('2025-11-01T10:00:00Z'),
        client: { id: 'client-1', name: 'Test Client', email: 'client@test.com' },
        lab: { id: 'lab-1', name: 'Test Lab', ownerId: 'lab-admin-1' },
        service: { id: 'service-1', name: 'pH Testing', category: 'Water Quality' },
        attachments: []
      }

      vi.mocked(prisma.order.findFirst).mockResolvedValue(mockOrder as any)

      const updatedOrder = {
        ...mockOrder,
        status: 'PENDING',  // Approved quotes become PENDING
        quoteApprovedAt: new Date()
      }

      // Mock transaction
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
        vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 1 } as any)
        vi.mocked(prisma.order.findUnique).mockResolvedValue(updatedOrder as any)
        return callback(prisma)
      })

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/approve-quote', {
        method: 'POST',
        body: JSON.stringify({ approved: true })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.status).toBe('PENDING')
      expect(data.quoteApprovedAt).toBeDefined()

      // Verify updateMany was called with atomic check
      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'order-1',
            status: 'QUOTE_PROVIDED'  // Atomic status check
          }),
          data: expect.objectContaining({
            status: 'PENDING',
            quoteApprovedAt: expect.any(Date),
            quoteRejectedReason: null
          })
        })
      )
    })
  })

  describe('Quote Rejection', () => {
    it('should successfully reject quote with valid reason', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      const mockOrder = {
        id: 'order-2',
        status: 'QUOTE_PROVIDED',
        clientId: 'client-1',
        labId: 'lab-1',
        serviceId: 'service-1',
        quotedPrice: 10000,
        quotedAt: new Date('2025-11-01T10:00:00Z'),
        client: { id: 'client-1', name: 'Test Client', email: 'client@test.com' },
        lab: { id: 'lab-1', name: 'Test Lab', ownerId: 'lab-admin-1' },
        service: { id: 'service-1', name: 'pH Testing', category: 'Water Quality' },
        attachments: []
      }

      vi.mocked(prisma.order.findFirst).mockResolvedValue(mockOrder as any)

      const updatedOrder = {
        ...mockOrder,
        status: 'QUOTE_REJECTED',
        quoteRejectedReason: 'Price exceeds our budget constraints',
        quoteRejectedAt: new Date()
      }

      // Mock transaction
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
        vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 1 } as any)
        vi.mocked(prisma.order.findUnique).mockResolvedValue(updatedOrder as any)
        return callback(prisma)
      })

      const request = new NextRequest('http://localhost:3000/api/orders/order-2/approve-quote', {
        method: 'POST',
        body: JSON.stringify({
          approved: false,
          rejectionReason: 'Price exceeds our budget constraints'
        })
      })

      const response = await POST(request, { params: { id: 'order-2' } })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.status).toBe('QUOTE_REJECTED')
      expect(data.quoteRejectedReason).toBe('Price exceeds our budget constraints')
      expect(data.quoteRejectedAt).toBeDefined()

      // Verify updateMany was called with atomic check
      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'order-2',
            status: 'QUOTE_PROVIDED'  // Atomic status check
          }),
          data: expect.objectContaining({
            status: 'QUOTE_REJECTED',
            quoteRejectedReason: 'Price exceeds our budget constraints',
            quoteRejectedAt: expect.any(Date)
          })
        })
      )
    })

    it('should reject rejection without reason', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        id: 'order-1',
        status: 'QUOTE_PROVIDED',
        clientId: 'client-1'
      } as any)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/approve-quote', {
        method: 'POST',
        body: JSON.stringify({ approved: false })  // Missing rejectionReason
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Validation error')
      expect(data.details).toBeDefined()
    })

    it('should reject rejection with too short reason (<10 chars)', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        id: 'order-1',
        status: 'QUOTE_PROVIDED',
        clientId: 'client-1'
      } as any)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/approve-quote', {
        method: 'POST',
        body: JSON.stringify({
          approved: false,
          rejectionReason: 'Too high'  // Only 8 characters
        })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Validation error')
    })
  })

  describe('Validation Errors', () => {
    beforeEach(() => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        id: 'order-1',
        status: 'QUOTE_PROVIDED',
        clientId: 'client-1'
      } as any)
    })

    it('should reject when approved field is missing', async () => {
      const request = new NextRequest('http://localhost:3000/api/orders/order-1/approve-quote', {
        method: 'POST',
        body: JSON.stringify({})  // Missing approved field
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Validation error')
    })

    it('should reject when approved is not boolean', async () => {
      const request = new NextRequest('http://localhost:3000/api/orders/order-1/approve-quote', {
        method: 'POST',
        body: JSON.stringify({ approved: 'yes' })  // String instead of boolean
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Validation error')
    })

    it('should reject rejection reason exceeding 500 characters', async () => {
      const request = new NextRequest('http://localhost:3000/api/orders/order-1/approve-quote', {
        method: 'POST',
        body: JSON.stringify({
          approved: false,
          rejectionReason: 'A'.repeat(501)
        })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Validation error')
    })
  })
})
