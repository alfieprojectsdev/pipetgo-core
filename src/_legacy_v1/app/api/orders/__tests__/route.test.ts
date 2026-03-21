import { describe, it, expect, beforeEach, vi } from 'vitest'
import { POST, GET } from '../route'
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
    labService: {
      findUnique: vi.fn()
    },
    order: {
      create: vi.fn(),
      findMany: vi.fn()
    },
    lab: {
      findFirst: vi.fn()
    }
  }
}))

describe('POST /api/orders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Authentication', () => {
    it('should reject unauthenticated requests', async () => {
      vi.mocked(getServerSession).mockResolvedValue(null)

      const request = new NextRequest('http://localhost:3000/api/orders', {
        method: 'POST',
        body: JSON.stringify({})
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(401)
      expect(data.error).toBe('Unauthorized')
    })

    it('should reject non-CLIENT users', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'lab-1', role: 'LAB_ADMIN', email: 'lab@test.com' }
      } as any)

      const request = new NextRequest('http://localhost:3000/api/orders', {
        method: 'POST',
        body: JSON.stringify({})
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(401)
      expect(data.error).toBe('Unauthorized')
    })
  })

  describe('FIXED Pricing Mode', () => {
    it('should create order with auto-populated quotedPrice for FIXED service', async () => {
      const mockSession = {
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      }

      const mockService = {
        id: 'service-1',
        labId: 'lab-1',
        name: 'pH Testing',
        pricingMode: 'FIXED',
        pricePerUnit: 500,
        active: true,
        lab: { id: 'lab-1', name: 'Test Lab' }
      }

      const mockOrder = {
        id: 'order-1',
        clientId: 'client-1',
        labId: 'lab-1',
        serviceId: 'service-1',
        status: 'PENDING',
        quotedPrice: 500,
        quotedAt: new Date(),
        sampleDescription: 'Water sample',
        service: mockService,
        lab: { name: 'Test Lab' },
        client: { name: 'Test Client', email: 'client@test.com' }
      }

      vi.mocked(getServerSession).mockResolvedValue(mockSession as any)
      vi.mocked(prisma.labService.findUnique).mockResolvedValue(mockService as any)
      vi.mocked(prisma.order.create).mockResolvedValue(mockOrder as any)

      const request = new NextRequest('http://localhost:3000/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          serviceId: 'service-1',
          sampleDescription: 'Water sample for pH testing',
          clientDetails: {
            contactEmail: 'client@test.com',
            shippingAddress: {
              street: '123 Test St',
              city: 'Test City',
              postal: '12345',
              country: 'Philippines'
            }
          }
        })
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.quotedPrice).toBe(500)
      expect(data.status).toBe('PENDING')

      // Verify order was created with correct data
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            quotedPrice: 500,
            quotedAt: expect.any(Date),
            status: 'PENDING'
          })
        })
      )
    })
  })

  describe('QUOTE_REQUIRED Pricing Mode', () => {
    it('should create order WITHOUT quotedPrice for QUOTE_REQUIRED service', async () => {
      const mockSession = {
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      }

      const mockService = {
        id: 'service-2',
        labId: 'lab-1',
        name: 'Fatty Acid Analysis',
        pricingMode: 'QUOTE_REQUIRED',
        pricePerUnit: null,
        active: true,
        lab: { id: 'lab-1', name: 'Test Lab' }
      }

      const mockOrder = {
        id: 'order-2',
        clientId: 'client-1',
        labId: 'lab-1',
        serviceId: 'service-2',
        status: 'QUOTE_REQUESTED',
        quotedPrice: null,
        quotedAt: null,
        sampleDescription: 'Coconut oil sample',
        service: mockService,
        lab: { name: 'Test Lab' },
        client: { name: 'Test Client', email: 'client@test.com' }
      }

      vi.mocked(getServerSession).mockResolvedValue(mockSession as any)
      vi.mocked(prisma.labService.findUnique).mockResolvedValue(mockService as any)
      vi.mocked(prisma.order.create).mockResolvedValue(mockOrder as any)

      const request = new NextRequest('http://localhost:3000/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          serviceId: 'service-2',
          sampleDescription: 'Coconut oil sample for fatty acid composition',
          clientDetails: {
            contactEmail: 'client@test.com',
            shippingAddress: {
              street: '123 Test St',
              city: 'Test City',
              postal: '12345',
              country: 'Philippines'
            }
          }
        })
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.quotedPrice).toBeNull()
      expect(data.quotedAt).toBeNull()
      expect(data.status).toBe('QUOTE_REQUESTED')

      // Verify order was created with NO quotedPrice
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            quotedPrice: null,
            quotedAt: null,
            status: 'QUOTE_REQUESTED'
          })
        })
      )
    })
  })

  describe('HYBRID Pricing Mode', () => {
    it('should create order with quotedPrice when requestCustomQuote=false', async () => {
      const mockSession = {
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      }

      const mockService = {
        id: 'service-3',
        labId: 'lab-1',
        name: 'Moisture Content Analysis',
        pricingMode: 'HYBRID',
        pricePerUnit: 800,
        active: true,
        lab: { id: 'lab-1', name: 'Test Lab' }
      }

      const mockOrder = {
        id: 'order-3',
        clientId: 'client-1',
        labId: 'lab-1',
        serviceId: 'service-3',
        status: 'PENDING',
        quotedPrice: 800,
        quotedAt: new Date(),
        sampleDescription: 'Food sample',
        service: mockService,
        lab: { name: 'Test Lab' },
        client: { name: 'Test Client', email: 'client@test.com' }
      }

      vi.mocked(getServerSession).mockResolvedValue(mockSession as any)
      vi.mocked(prisma.labService.findUnique).mockResolvedValue(mockService as any)
      vi.mocked(prisma.order.create).mockResolvedValue(mockOrder as any)

      const request = new NextRequest('http://localhost:3000/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          serviceId: 'service-3',
          sampleDescription: 'Food sample for moisture analysis',
          requestCustomQuote: false,
          clientDetails: {
            contactEmail: 'client@test.com',
            shippingAddress: {
              street: '123 Test St',
              city: 'Test City',
              postal: '12345',
              country: 'Philippines'
            }
          }
        })
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.quotedPrice).toBe(800)
      expect(data.status).toBe('PENDING')
    })

    it('should create order WITHOUT quotedPrice when requestCustomQuote=true', async () => {
      const mockSession = {
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      }

      const mockService = {
        id: 'service-3',
        labId: 'lab-1',
        name: 'Moisture Content Analysis',
        pricingMode: 'HYBRID',
        pricePerUnit: 800,
        active: true,
        lab: { id: 'lab-1', name: 'Test Lab' }
      }

      const mockOrder = {
        id: 'order-4',
        clientId: 'client-1',
        labId: 'lab-1',
        serviceId: 'service-3',
        status: 'QUOTE_REQUESTED',
        quotedPrice: null,
        quotedAt: null,
        sampleDescription: 'Large batch sample',
        service: mockService,
        lab: { name: 'Test Lab' },
        client: { name: 'Test Client', email: 'client@test.com' }
      }

      vi.mocked(getServerSession).mockResolvedValue(mockSession as any)
      vi.mocked(prisma.labService.findUnique).mockResolvedValue(mockService as any)
      vi.mocked(prisma.order.create).mockResolvedValue(mockOrder as any)

      const request = new NextRequest('http://localhost:3000/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          serviceId: 'service-3',
          sampleDescription: 'Large batch sample requiring custom pricing',
          requestCustomQuote: true,
          clientDetails: {
            contactEmail: 'client@test.com',
            shippingAddress: {
              street: '123 Test St',
              city: 'Test City',
              postal: '12345',
              country: 'Philippines'
            }
          }
        })
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.quotedPrice).toBeNull()
      expect(data.status).toBe('QUOTE_REQUESTED')
    })
  })

  describe('Error Handling', () => {
    it('should return 404 for inactive service', async () => {
      const mockSession = {
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      }

      vi.mocked(getServerSession).mockResolvedValue(mockSession as any)
      vi.mocked(prisma.labService.findUnique).mockResolvedValue({
        id: 'service-1',
        active: false
      } as any)

      const request = new NextRequest('http://localhost:3000/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          serviceId: 'service-1',
          sampleDescription: 'Test sample',
          clientDetails: {
            contactEmail: 'client@test.com',
            shippingAddress: {
              street: '123 Test St',
              city: 'Test City',
              postal: '12345',
              country: 'Philippines'
            }
          }
        })
      })

      const response = await POST(request)
      expect(response.status).toBe(404)
    })

    it('should return 404 for non-existent service', async () => {
      const mockSession = {
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      }

      vi.mocked(getServerSession).mockResolvedValue(mockSession as any)
      vi.mocked(prisma.labService.findUnique).mockResolvedValue(null)

      const request = new NextRequest('http://localhost:3000/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          serviceId: 'non-existent',
          sampleDescription: 'Test sample',
          clientDetails: {
            contactEmail: 'client@test.com',
            shippingAddress: {
              street: '123 Test St',
              city: 'Test City',
              postal: '12345',
              country: 'Philippines'
            }
          }
        })
      })

      const response = await POST(request)
      expect(response.status).toBe(404)
    })

    it('should return 400 for invalid data', async () => {
      const mockSession = {
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      }

      vi.mocked(getServerSession).mockResolvedValue(mockSession as any)

      const request = new NextRequest('http://localhost:3000/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          serviceId: 'service-1',
          sampleDescription: 'Short',  // Too short (min 10 chars)
          clientDetails: {
            contactEmail: 'invalid-email',  // Invalid email
            shippingAddress: {}  // Missing required fields
          }
        })
      })

      const response = await POST(request)
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toBe('Validation error')
    })
  })
})
