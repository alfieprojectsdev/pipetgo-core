import { describe, it, expect, beforeEach, vi } from 'vitest'
import { POST as createOrder } from '../route'
import { POST as provideQuote } from '../[id]/quote/route'
import { POST as approveQuote } from '../[id]/approve-quote/route'
import { POST as requestCustomQuote } from '../[id]/request-custom-quote/route'
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
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn()
    },
    $transaction: vi.fn()
  }
}))

describe('Quote Workflow Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Full QUOTE_REQUIRED Workflow', () => {
    it('should complete full workflow: Create RFQ → Provide Quote → Approve Quote', async () => {
      // Step 1: Client creates RFQ for QUOTE_REQUIRED service
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      const quoteRequiredService = {
        id: 'service-1',
        labId: 'lab-1',
        pricingMode: 'QUOTE_REQUIRED',
        pricePerUnit: null,
        active: true
      }

      vi.mocked(prisma.labService.findUnique).mockResolvedValue(quoteRequiredService as any)

      const createdOrder = {
        id: 'order-1',
        clientId: 'client-1',
        labId: 'lab-1',
        serviceId: 'service-1',
        status: 'QUOTE_REQUESTED',
        quotedPrice: null,
        quotedAt: null,
        sampleDescription: 'Water sample for pesticide analysis',
        service: { name: 'Pesticide Residue Analysis' },
        lab: { name: 'BioAnalytica Lab' },
        client: { name: 'Test Client', email: 'client@test.com' }
      }

      vi.mocked(prisma.order.create).mockResolvedValue(createdOrder as any)

      const createRequest = new NextRequest('http://localhost:3000/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          serviceId: 'service-1',
          sampleDescription: 'Water sample for pesticide analysis',
          clientDetails: {
            contactEmail: 'client@test.com',
            contactPhone: '+63 912 345 6789',
            shippingAddress: {
              street: '123 Main St',
              city: 'Manila',
              postal: '1000',
              country: 'Philippines'
            }
          }
        })
      })

      const createResponse = await createOrder(createRequest)
      const orderData = await createResponse.json()

      expect(createResponse.status).toBe(201)
      expect(orderData.status).toBe('QUOTE_REQUESTED')
      expect(orderData.quotedPrice).toBeNull()

      // Step 2: Lab admin provides custom quote
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'lab-admin-1', role: 'LAB_ADMIN', email: 'admin@bioanalytica.com' }
      } as any)

      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        ...createdOrder,
        lab: { id: 'lab-1', ownerId: 'lab-admin-1', name: 'BioAnalytica Lab' }
      } as any)

      const quotedOrder = {
        ...createdOrder,
        quotedPrice: 8500,
        quotedAt: new Date(),
        quoteNotes: 'Comprehensive pesticide screening panel',
        estimatedTurnaroundDays: 7,
        status: 'QUOTE_PROVIDED',
        service: quoteRequiredService,
        lab: { id: 'lab-1', ownerId: 'lab-admin-1', name: 'BioAnalytica Lab' },
        client: { id: 'client-1', name: 'Test Client', email: 'client@test.com' }
      }

      // Mock transaction for quote provision
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
        vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 1 } as any)
        vi.mocked(prisma.order.findUnique).mockResolvedValue(quotedOrder as any)
        return callback(prisma)
      })

      const quoteRequest = new NextRequest('http://localhost:3000/api/orders/order-1/quote', {
        method: 'POST',
        body: JSON.stringify({
          quotedPrice: 8500,
          quoteNotes: 'Comprehensive pesticide screening panel',
          estimatedTurnaroundDays: 7
        })
      })

      const quoteResponse = await provideQuote(quoteRequest, { params: { id: 'order-1' } })
      const quoteData = await quoteResponse.json()

      expect(quoteResponse.status).toBe(200)
      expect(quoteData.status).toBe('QUOTE_PROVIDED')
      expect(quoteData.quotedPrice).toBe(8500)

      // Step 3: Client approves quote
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        ...quotedOrder,
        client: { id: 'client-1', name: 'Test Client', email: 'client@test.com' }
      } as any)

      const approvedOrder = {
        ...quotedOrder,
        status: 'PENDING',
        quoteApprovedAt: new Date()
      }

      // Mock transaction for quote approval
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
        vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 1 } as any)
        vi.mocked(prisma.order.findUnique).mockResolvedValue(approvedOrder as any)
        return callback(prisma)
      })

      const approveRequest = new NextRequest('http://localhost:3000/api/orders/order-1/approve-quote', {
        method: 'POST',
        body: JSON.stringify({ approved: true })
      })

      const approveResponse = await approveQuote(approveRequest, { params: { id: 'order-1' } })
      const approveData = await approveResponse.json()

      expect(approveResponse.status).toBe(200)
      expect(approveData.status).toBe('PENDING')
      expect(approveData.quoteApprovedAt).toBeDefined()
    })
  })

  describe('Quote Rejection Workflow', () => {
    it('should allow client to reject quote with reason', async () => {
      // Lab provides quote
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      const orderWithQuote = {
        id: 'order-2',
        clientId: 'client-1',
        status: 'QUOTE_PROVIDED',
        quotedPrice: 15000,
        quotedAt: new Date()
      }

      vi.mocked(prisma.order.findFirst).mockResolvedValue(orderWithQuote as any)

      const rejectedOrder = {
        ...orderWithQuote,
        status: 'QUOTE_REJECTED',
        quoteRejectedReason: 'Budget constraint - exceeds our allocated amount',
        quoteRejectedAt: new Date()
      }

      // Mock transaction for quote rejection
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
        vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 1 } as any)
        vi.mocked(prisma.order.findUnique).mockResolvedValue(rejectedOrder as any)
        return callback(prisma)
      })

      const rejectRequest = new NextRequest('http://localhost:3000/api/orders/order-2/approve-quote', {
        method: 'POST',
        body: JSON.stringify({
          approved: false,
          rejectionReason: 'Budget constraint - exceeds our allocated amount'
        })
      })

      const rejectResponse = await approveQuote(rejectRequest, { params: { id: 'order-2' } })
      const rejectData = await rejectResponse.json()

      expect(rejectResponse.status).toBe(200)
      expect(rejectData.status).toBe('QUOTE_REJECTED')
      expect(rejectData.quoteRejectedReason).toBe('Budget constraint - exceeds our allocated amount')
    })
  })

  describe('FIXED Service Workflow (Backward Compatibility)', () => {
    it('should create order with instant PENDING status for FIXED services', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      const fixedService = {
        id: 'service-fixed',
        labId: 'lab-1',
        pricingMode: 'FIXED',
        pricePerUnit: 500,
        active: true
      }

      vi.mocked(prisma.labService.findUnique).mockResolvedValue(fixedService as any)

      const fixedOrder = {
        id: 'order-fixed',
        clientId: 'client-1',
        status: 'PENDING',
        quotedPrice: 500,
        quotedAt: new Date(),
        service: { name: 'pH Testing' },
        lab: { name: 'QuickTest Lab' },
        client: { name: 'Test Client', email: 'client@test.com' }
      }

      vi.mocked(prisma.order.create).mockResolvedValue(fixedOrder as any)

      const request = new NextRequest('http://localhost:3000/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          serviceId: 'service-fixed',
          sampleDescription: 'Water pH testing',
          clientDetails: {
            contactEmail: 'client@test.com',
            shippingAddress: {
              street: '123 Main St',
              city: 'Manila',
              postal: '1000',
              country: 'Philippines'
            }
          }
        })
      })

      const response = await createOrder(request)
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.status).toBe('PENDING')
      expect(data.quotedPrice).toBe(500)
    })
  })

  describe('HYBRID Instant Booking Workflow', () => {
    it('should create PENDING order when client accepts reference price (requestCustomQuote=false)', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      const hybridService = {
        id: 'service-hybrid',
        labId: 'lab-1',
        pricingMode: 'HYBRID',
        pricePerUnit: 1200,
        active: true
      }

      vi.mocked(prisma.labService.findUnique).mockResolvedValue(hybridService as any)

      const hybridOrder = {
        id: 'order-hybrid',
        clientId: 'client-1',
        status: 'PENDING',
        quotedPrice: 1200,
        quotedAt: new Date(),
        service: { name: 'Moisture Content Analysis' },
        lab: { name: 'FlexLab' },
        client: { name: 'Test Client', email: 'client@test.com' }
      }

      vi.mocked(prisma.order.create).mockResolvedValue(hybridOrder as any)

      const request = new NextRequest('http://localhost:3000/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          serviceId: 'service-hybrid',
          sampleDescription: 'Grain moisture content',
          requestCustomQuote: false,  // Accept reference price
          clientDetails: {
            contactEmail: 'client@test.com',
            shippingAddress: {
              street: '123 Main St',
              city: 'Manila',
              postal: '1000',
              country: 'Philippines'
            }
          }
        })
      })

      const response = await createOrder(request)
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.status).toBe('PENDING')
      expect(data.quotedPrice).toBe(1200)
    })

    it('should create QUOTE_REQUESTED order when client requests custom quote (requestCustomQuote=true)', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      const hybridService = {
        id: 'service-hybrid-2',
        labId: 'lab-1',
        pricingMode: 'HYBRID',
        pricePerUnit: 1500,
        active: true
      }

      vi.mocked(prisma.labService.findUnique).mockResolvedValue(hybridService as any)

      const hybridOrder = {
        id: 'order-hybrid-2',
        clientId: 'client-1',
        status: 'QUOTE_REQUESTED',
        quotedPrice: null,
        quotedAt: null,
        service: { name: 'Protein Analysis' },
        lab: { name: 'FlexLab' },
        client: { name: 'Test Client', email: 'client@test.com' }
      }

      vi.mocked(prisma.order.create).mockResolvedValue(hybridOrder as any)

      const request = new NextRequest('http://localhost:3000/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          serviceId: 'service-hybrid-2',
          sampleDescription: 'Bulk protein analysis',
          requestCustomQuote: true,  // Request custom quote
          clientDetails: {
            contactEmail: 'client@test.com',
            shippingAddress: {
              street: '123 Main St',
              city: 'Manila',
              postal: '1000',
              country: 'Philippines'
            }
          }
        })
      })

      const response = await createOrder(request)
      const data = await response.json()

      expect(response.status).toBe(201)
      expect(data.status).toBe('QUOTE_REQUESTED')
      expect(data.quotedPrice).toBeNull()
    })
  })

  describe('HYBRID Custom Quote Request Workflow', () => {
    it('should allow client to switch from instant booking to custom quote', async () => {
      // Step 1: Client initially books at fixed price
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      const hybridService = {
        id: 'service-hybrid-3',
        pricingMode: 'HYBRID',
        pricePerUnit: 2000
      }

      vi.mocked(prisma.labService.findUnique).mockResolvedValue(hybridService as any)

      const initialOrder = {
        id: 'order-hybrid-3',
        clientId: 'client-1',
        status: 'PENDING',
        quotedPrice: 2000,
        quotedAt: new Date(),
        specialInstructions: 'Standard processing'
      }

      vi.mocked(prisma.order.create).mockResolvedValue(initialOrder as any)

      // Step 2: Client requests custom quote
      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        ...initialOrder,
        service: { id: 'service-hybrid-3', pricingMode: 'HYBRID' }
      } as any)

      const requestedOrder = {
        ...initialOrder,
        quotedPrice: null,
        quotedAt: null,
        status: 'QUOTE_REQUESTED',
        specialInstructions: 'Standard processing\n\nCustom Quote Requested: Need bulk discount for 100+ samples'
      }

      vi.mocked(prisma.order.update).mockResolvedValue(requestedOrder as any)

      const customQuoteRequest = new NextRequest('http://localhost:3000/api/orders/order-hybrid-3/request-custom-quote', {
        method: 'POST',
        body: JSON.stringify({
          reason: 'Need bulk discount for 100+ samples'
        })
      })

      const customQuoteResponse = await requestCustomQuote(customQuoteRequest, { params: { id: 'order-hybrid-3' } })
      const customQuoteData = await customQuoteResponse.json()

      expect(customQuoteResponse.status).toBe(200)
      expect(customQuoteData.status).toBe('QUOTE_REQUESTED')
      expect(customQuoteData.quotedPrice).toBeNull()
      expect(customQuoteData.specialInstructions).toContain('Custom Quote Requested: Need bulk discount for 100+ samples')

      // Step 3: Lab provides custom quote
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'lab-admin-1', role: 'LAB_ADMIN', email: 'admin@flexlab.com' }
      } as any)

      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        ...requestedOrder,
        lab: { ownerId: 'lab-admin-1' }
      } as any)

      const customQuotedOrder = {
        ...requestedOrder,
        quotedPrice: 150000,  // Bulk discount applied
        quotedAt: new Date(),
        quoteNotes: 'Bulk discount applied: 100+ samples at ₱1,500 each',
        status: 'QUOTE_PROVIDED',
        service: hybridService,
        lab: { ownerId: 'lab-admin-1', name: 'FlexLab' },
        client: { id: 'client-1', name: 'Test Client', email: 'client@test.com' }
      }

      // Mock transaction for quote provision
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
        vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 1 } as any)
        vi.mocked(prisma.order.findUnique).mockResolvedValue(customQuotedOrder as any)
        return callback(prisma)
      })

      const provideQuoteRequest = new NextRequest('http://localhost:3000/api/orders/order-hybrid-3/quote', {
        method: 'POST',
        body: JSON.stringify({
          quotedPrice: 150000,
          quoteNotes: 'Bulk discount applied: 100+ samples at ₱1,500 each'
        })
      })

      const provideQuoteResponse = await provideQuote(provideQuoteRequest, { params: { id: 'order-hybrid-3' } })
      const provideQuoteData = await provideQuoteResponse.json()

      expect(provideQuoteResponse.status).toBe(200)
      expect(provideQuoteData.quotedPrice).toBe(150000)
      expect(provideQuoteData.status).toBe('QUOTE_PROVIDED')

      // Step 4: Client approves custom quote
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        ...customQuotedOrder,
        clientId: 'client-1'
      } as any)

      const finalOrder = {
        ...customQuotedOrder,
        status: 'PENDING',
        quoteApprovedAt: new Date()
      }

      // Mock transaction for quote approval
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
        vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 1 } as any)
        vi.mocked(prisma.order.findUnique).mockResolvedValue(finalOrder as any)
        return callback(prisma)
      })

      const approveRequest = new NextRequest('http://localhost:3000/api/orders/order-hybrid-3/approve-quote', {
        method: 'POST',
        body: JSON.stringify({ approved: true })
      })

      const approveResponse = await approveQuote(approveRequest, { params: { id: 'order-hybrid-3' } })
      const approveData = await approveResponse.json()

      expect(approveResponse.status).toBe(200)
      expect(approveData.status).toBe('PENDING')
    })
  })

  describe('Authorization Edge Cases', () => {
    it('should prevent CLIENT from providing quotes', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/quote', {
        method: 'POST',
        body: JSON.stringify({ quotedPrice: 5000 })
      })

      const response = await provideQuote(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(403)
      expect(data.error).toBe('Only lab administrators can provide quotes')
    })

    it('should prevent LAB_ADMIN from approving quotes', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'lab-admin-1', role: 'LAB_ADMIN', email: 'admin@lab.com' }
      } as any)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/approve-quote', {
        method: 'POST',
        body: JSON.stringify({ approved: true })
      })

      const response = await approveQuote(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(403)
      expect(data.error).toBe('Only clients can approve or reject quotes')
    })

    it('should prevent LAB_ADMIN from requesting custom quotes', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'lab-admin-1', role: 'LAB_ADMIN', email: 'admin@lab.com' }
      } as any)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/request-custom-quote', {
        method: 'POST',
        body: JSON.stringify({ reason: 'Testing authorization' })
      })

      const response = await requestCustomQuote(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(403)
      expect(data.error).toBe('Only clients can request custom quotes')
    })
  })

  describe('State Machine Violations', () => {
    it('should prevent providing quote twice for same order', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'lab-admin-1', role: 'LAB_ADMIN', email: 'admin@lab.com' }
      } as any)

      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        id: 'order-1',
        status: 'QUOTE_PROVIDED',  // Already has quote
        lab: { ownerId: 'lab-admin-1' }
      } as any)

      // Mock transaction to simulate race condition (updateMany returns 0)
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
        vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 0 } as any)  // Race condition
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

      const response = await provideQuote(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(409)  // 409 Conflict for race condition
      expect(data.error).toContain('Quote already provided')
    })

    it('should prevent approving quote that has not been provided', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        id: 'order-1',
        status: 'QUOTE_REQUESTED',  // No quote yet
        clientId: 'client-1'
      } as any)

      // Mock transaction to simulate race condition (updateMany returns 0)
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
        vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 0 } as any)  // Race condition
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

      const response = await approveQuote(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(409)  // 409 Conflict for invalid state
      expect(data.error).toContain('Quote can only be approved/rejected when status is QUOTE_PROVIDED')
    })

    it('should prevent requesting custom quote for non-HYBRID services', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        id: 'order-1',
        status: 'PENDING',
        clientId: 'client-1',
        service: { pricingMode: 'FIXED' }  // Not HYBRID
      } as any)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/request-custom-quote', {
        method: 'POST',
        body: JSON.stringify({ reason: 'Want a custom quote' })
      })

      const response = await requestCustomQuote(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toContain('only available for HYBRID pricing mode services')
    })

    it('should prevent requesting custom quote for orders not in PENDING status', async () => {
      vi.mocked(getServerSession).mockResolvedValue({
        user: { id: 'client-1', role: 'CLIENT', email: 'client@test.com' }
      } as any)

      vi.mocked(prisma.order.findFirst).mockResolvedValue({
        id: 'order-1',
        status: 'IN_PROGRESS',  // Already in progress
        clientId: 'client-1',
        service: { pricingMode: 'HYBRID' }
      } as any)

      const request = new NextRequest('http://localhost:3000/api/orders/order-1/request-custom-quote', {
        method: 'POST',
        body: JSON.stringify({ reason: 'Too late to request custom quote' })
      })

      const response = await requestCustomQuote(request, { params: { id: 'order-1' } })
      const data = await response.json()

      expect(response.status).toBe(400)
      expect(data.error).toContain('can only request custom quote for orders with status PENDING')
    })
  })
})
