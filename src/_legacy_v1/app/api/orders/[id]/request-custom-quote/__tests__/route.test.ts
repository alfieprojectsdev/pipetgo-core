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
      update: vi.fn()
    }
  }
}))

describe('POST /api/orders/[id]/request-custom-quote', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Authentication & Authorization', () => {
    it('should reject unauthenticated requests', async () => {
      vi.mocked(getServerSession).mockResolvedValue(null)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/request-custom-quote', {
        method: 'POST',
        body: JSON.stringify({ reason: 'Need special handling for bulk samples' })
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

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/request-custom-quote', {
        method: 'POST',
        body: JSON.stringify({ reason: 'Need special handling for bulk samples' })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(403)
      expect(data.error).toBe('Only clients can request custom quotes')
    })

    it('should reject CLIENT who does not own the order', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client1@test.com' }
      } as any)

      // Order exists but belongs to different client
      vi.mocked(prisma.order.findFirst).mockResolvedValue(null)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/request-custom-quote', {
        method: 'POST',
        body: JSON.stringify({ reason: 'Need special handling for bulk samples' })
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

  describe('Service Pricing Mode Validation', () => {
    beforeEach(() => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)
    })

    it('should reject FIXED pricing mode services', async () => {
      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        id: 'order-1',
        status: 'PENDING',
        clientId: 'client-1',
        service: {
          id: 'service-1',
          pricingMode: 'FIXED',
          name: 'pH Testing'
        }
      } as any)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/request-custom-quote', {
        method: 'POST',
        body: JSON.stringify({ reason: 'Need special handling for bulk samples' })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toContain('only available for HYBRID pricing mode services')
    })

    it('should reject QUOTE_REQUIRED pricing mode services', async () => {
      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        id: 'order-2',
        status: 'QUOTE_REQUESTED',  // Already requesting quote
        clientId: 'client-1',
        service: {
          id: 'service-2',
          pricingMode: 'QUOTE_REQUIRED',
          name: 'Fatty Acid Analysis'
        }
      } as any)

      const request = new NextRequest('http://localhost:3000/api/orders/order-2/request-custom-quote', {
        method: 'POST',
        body: JSON.stringify({ reason: 'Need special handling for bulk samples' })
      })

      const response = await POST(request, { params: { id: 'order-2' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toContain('only available for HYBRID pricing mode services')
    })
  })

  describe('State Machine Validation', () => {
    beforeEach(() => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)
    })

    it('should reject if order not in PENDING status', async () => {
      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        id: 'order-1',
        status: 'QUOTE_REQUESTED',  // Already requesting quote
        clientId: 'client-1',
        service: { pricingMode: 'HYBRID' }
      } as any)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/request-custom-quote', {
        method: 'POST',
        body: JSON.stringify({ reason: 'Need special handling for bulk samples' })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toContain('can only request custom quote for orders with status PENDING')
    })

    it('should reject if order already in progress', async () => {
      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        id: 'order-1',
        status: 'IN_PROGRESS',
        clientId: 'client-1',
        service: { pricingMode: 'HYBRID' }
      } as any)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/request-custom-quote', {
        method: 'POST',
        body: JSON.stringify({ reason: 'Need special handling for bulk samples' })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toContain('can only request custom quote for orders with status PENDING')
    })
  })

  describe('Successful Custom Quote Request', () => {
    it('should successfully request custom quote for HYBRID service in PENDING state', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      const mockOrder = {
        id: 'order-1',
        status: 'PENDING',
        clientId: 'client-1',
        quotedPrice: 1000,  // Initially booked at fixed price
        quotedAt: new Date('2025-11-01T10:00:00Z'),
        specialInstructions: 'Standard sample handling',
        service: {
          id: 'service-1',
          pricingMode: 'HYBRID',
          name: 'Gas Chromatography'
        },
        client: { id: 'client-1', name: 'Test Client', email: 'client@test.com' },
        lab: { id: 'lab-1', name: 'Test Lab' }
      }

      vi.mocked(prisma.order.findFirst).mockResolvedValue(mockOrder as any)

      const updatedOrder = {
        ...mockOrder,
        quotedPrice: null,  // Reset to null (awaiting custom quote)
        quotedAt: null,
        status: 'QUOTE_REQUESTED',
        specialInstructions: 'Standard sample handling\n\nCustom Quote Requested: Need special handling for bulk samples'
      }

      vi.mocked(prisma.order.update).mockResolvedValue(updatedOrder as any)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/request-custom-quote', {
        method: 'POST',
        body: JSON.stringify({
          reason: 'Need special handling for bulk samples'
        })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.quotedPrice).toBeNull()
      expect(data.quotedAt).toBeNull()
      expect(data.status).toBe('QUOTE_REQUESTED')
      expect(data.specialInstructions).toContain('Custom Quote Requested: Need special handling for bulk samples')

      // Verify update was called with correct data
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'order-1' },
          data: expect.objectContaining({
            quotedPrice: null,
            quotedAt: null,
            status: 'QUOTE_REQUESTED',
            specialInstructions: expect.stringContaining('Custom Quote Requested: Need special handling for bulk samples')
          })
        })
      )
    })

    it('should append reason to existing specialInstructions', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      const mockOrder = {
        id: 'order-2',
        status: 'PENDING',
        clientId: 'client-1',
        quotedPrice: 800,
        quotedAt: new Date(),
        specialInstructions: 'Existing instructions',
        service: { pricingMode: 'HYBRID' }
      }

      vi.mocked(prisma.order.findFirst).mockResolvedValue(mockOrder as any)

      const updatedOrder = {
        ...mockOrder,
        quotedPrice: null,
        quotedAt: null,
        status: 'QUOTE_REQUESTED',
        specialInstructions: 'Existing instructions\n\nCustom Quote Requested: Urgent turnaround needed'
      }

      vi.mocked(prisma.order.update).mockResolvedValue(updatedOrder as any)

      const request = new NextRequest('http://localhost:3000/api/orders/order-2/request-custom-quote', {
        method: 'POST',
        body: JSON.stringify({ reason: 'Urgent turnaround needed' })
      })

      const response = await POST(request, { params: { id: 'order-2' } })
      const data = await response.json()

      expect(response.status).toBe(200)
      expect(data.specialInstructions).toBe('Existing instructions\n\nCustom Quote Requested: Urgent turnaround needed')
    })
  })

  describe('Validation Errors', () => {
    beforeEach(() => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        id: 'order-1',
        status: 'PENDING',
        clientId: 'client-1',
        service: { pricingMode: 'HYBRID' }
      } as any)
    })

    it('should reject reason less than 10 characters', async () => {
      const request = new NextRequest('http://localhost:3000/api/orders/order-1/request-custom-quote', {
        method: 'POST',
        body: JSON.stringify({ reason: 'Too short' })  // Only 9 characters
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Validation error')
      expect(data.details).toBeDefined()
    })

    it('should reject reason exceeding 500 characters', async () => {
      const request = new NextRequest('http://localhost:3000/api/orders/order-1/request-custom-quote', {
        method: 'POST',
        body: JSON.stringify({ reason: 'A'.repeat(501) })
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Validation error')
    })

    it('should reject empty reason after trimming whitespace', async () => {
      const request = new NextRequest('http://localhost:3000/api/orders/order-1/request-custom-quote', {
        method: 'POST',
        body: JSON.stringify({ reason: '          ' })  // Only whitespace
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Validation error')
    })

    it('should reject missing reason field', async () => {
      const request = new NextRequest('http://localhost:3000/api/orders/order-1/request-custom-quote', {
        method: 'POST',
        body: JSON.stringify({})  // Missing reason
      })

      const response = await POST(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Validation error')
    })
  })
})
