/**
 * PipetGo - B2B Lab Testing Marketplace
 * Copyright (c) 2025 PIPETGO, Inc. All rights reserved.
 * 
 * This file and its contents are the proprietary intellectual property of PIPETGO, Inc.
 * Unauthorized use, reproduction, or distribution is strictly prohibited.
 */

/**
 * Analytics API Endpoint
 * ======================
 * Provides comprehensive analytics data for lab administrators.
 *
 * SECURITY:
 * - Authentication: Required (NextAuth session)
 * - Authorization: LAB_ADMIN role only
 * - Ownership: Only returns data for user's lab
 *
 * QUERY PARAMETERS:
 * - timeframe: 'last30days' | 'last90days' | 'thisYear' | 'allTime' (default: 'last30days')
 *
 * RESPONSE: AnalyticsData (see types/index.ts)
 */

import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { OrderStatus } from '@prisma/client'
import { Decimal } from '@prisma/client/runtime/library'

// Force dynamic rendering (no caching)
export const dynamic = 'force-dynamic'

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * Monthly data structure
 */
interface MonthlyDataEntry {
  revenue: number
  orderCount: number
}

export async function GET(req: Request) {
  try {
    // ========================================================================
    // 1. AUTHENTICATION & AUTHORIZATION
    // ========================================================================
    const session = await getServerSession(authOptions)

    if (!session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    if (session.user.role !== 'LAB_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    // ========================================================================
    // 2. VERIFY LAB OWNERSHIP
    // ========================================================================
    const lab = await prisma.lab.findFirst({
      where: { ownerId: session.user.id }
    })

    if (!lab) {
      return NextResponse.json({ error: 'Lab not found' }, { status: 404 })
    }

    // ========================================================================
    // 3. PARSE QUERY PARAMETERS
    // ========================================================================
    const { searchParams } = new URL(req.url)
    const timeframe = searchParams.get('timeframe') || 'last30days'

    // ========================================================================
    // 4. CALCULATE DATE RANGE
    // ========================================================================
    const now = new Date()
    let startDate: Date
    let previousPeriodStart: Date
    let previousPeriodEnd: Date

    switch (timeframe) {
      case 'last30days':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
        previousPeriodStart = new Date(startDate.getTime() - 30 * 24 * 60 * 60 * 1000)
        previousPeriodEnd = startDate
        break
      case 'last90days':
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)
        previousPeriodStart = new Date(startDate.getTime() - 90 * 24 * 60 * 60 * 1000)
        previousPeriodEnd = startDate
        break
      case 'thisYear':
        startDate = new Date(now.getFullYear(), 0, 1)
        previousPeriodStart = new Date(now.getFullYear() - 1, 0, 1)
        previousPeriodEnd = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59)
        break
      case 'allTime':
        startDate = new Date(2020, 0, 1) // PipetGo launch date
        previousPeriodStart = startDate
        previousPeriodEnd = startDate
        break
      default:
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
        previousPeriodStart = new Date(startDate.getTime() - 30 * 24 * 60 * 60 * 1000)
        previousPeriodEnd = startDate
    }

    // ========================================================================
    // 5. REVENUE METRICS (Optimized with Aggregation)
    // ========================================================================
    const revenueAgg = await prisma.order.aggregate({
      where: {
        labId: lab.id,
        createdAt: { gte: startDate },
        status: OrderStatus.COMPLETED
      },
      _sum: { quotedPrice: true }
    })

    const totalRevenue = revenueAgg._sum.quotedPrice ? Number(revenueAgg._sum.quotedPrice) : 0

    // Fetch previous period revenue for growth calculation
    const previousRevenueAgg = timeframe !== 'allTime'
      ? await prisma.order.aggregate({
          where: {
            labId: lab.id,
            createdAt: {
              gte: previousPeriodStart,
              lt: previousPeriodEnd
            },
            status: OrderStatus.COMPLETED
          },
          _sum: { quotedPrice: true }
        })
      : { _sum: { quotedPrice: 0 } }

    const previousRevenue = previousRevenueAgg._sum.quotedPrice ? Number(previousRevenueAgg._sum.quotedPrice) : 0

    const revenueGrowth = previousRevenue > 0
      ? ((totalRevenue - previousRevenue) / previousRevenue) * 100
      : totalRevenue > 0 ? 100 : 0

    // ========================================================================
    // 6. QUOTE STATISTICS (Optimized with Aggregation)
    // ========================================================================
    const quotesAgg = await prisma.order.aggregate({
      where: {
        labId: lab.id,
        createdAt: { gte: startDate },
        quotedPrice: { not: null }
      },
      _count: { _all: true }
    })
    const totalQuotes = quotesAgg._count._all

    // Accepted quotes
    const acceptedQuotesAgg = await prisma.order.aggregate({
      where: {
        labId: lab.id,
        createdAt: { gte: startDate },
        quotedPrice: { not: null },
        status: {
          in: [
            OrderStatus.PENDING,
            OrderStatus.ACKNOWLEDGED,
            OrderStatus.IN_PROGRESS,
            OrderStatus.COMPLETED
          ]
        }
      },
      _count: { _all: true },
      _avg: { quotedPrice: true }
    })
    const acceptedQuotesCount = acceptedQuotesAgg._count._all
    const avgQuotePrice = acceptedQuotesAgg._avg.quotedPrice ? Number(acceptedQuotesAgg._avg.quotedPrice) : 0

    const acceptanceRate = totalQuotes > 0
      ? (acceptedQuotesCount / totalQuotes) * 100
      : 0

    // Pending quotes (QUOTE_PROVIDED)
    const pendingQuotesCount = await prisma.order.count({
      where: {
        labId: lab.id,
        createdAt: { gte: startDate },
        status: OrderStatus.QUOTE_PROVIDED
      }
    })

    // ========================================================================
    // 7. ORDER VOLUME (Optimized with Aggregation)
    // ========================================================================
    const orderCounts = await prisma.order.groupBy({
      by: ['status'],
      where: {
        labId: lab.id,
        createdAt: { gte: startDate }
      },
      _count: { _all: true }
    })

    // Process counts map
    let totalOrders = 0
    let completedOrdersCount = 0
    let inProgressOrdersCount = 0

    orderCounts.forEach(group => {
      totalOrders += group._count._all
      if (group.status === OrderStatus.COMPLETED) completedOrdersCount = group._count._all
      if (group.status === OrderStatus.IN_PROGRESS) inProgressOrdersCount = group._count._all
    })

    // ========================================================================
    // 8. MONTHLY BREAKDOWN (Optimized Fetch - Minimal Fields)
    // ========================================================================
    // We still need to fetch some data for monthly breakdown as grouping by
    // month in SQL via Prisma is complex and DB-dependent.
    // However, we select ONLY necessary fields.
    const ordersForMonthly = await prisma.order.findMany({
      where: {
        labId: lab.id,
        createdAt: { gte: startDate }
      },
      select: {
        createdAt: true,
        quotedPrice: true,
        status: true
      }
    })

    const monthlyRevenue = calculateMonthlyBreakdown(
      ordersForMonthly.filter(o => o.status === OrderStatus.COMPLETED),
      12
    )
    const monthlyVolume = calculateMonthlyVolume(ordersForMonthly, 12)

    // ========================================================================
    // 9. TOP SERVICES (Optimized with GroupBy)
    // ========================================================================
    const topServicesGrouped = await prisma.order.groupBy({
      by: ['serviceId'],
      where: {
        labId: lab.id,
        createdAt: { gte: startDate },
        status: OrderStatus.COMPLETED
      },
      _sum: { quotedPrice: true },
      _count: { id: true },
      orderBy: {
        _sum: { quotedPrice: 'desc' }
      },
      take: 10
    })

    // Fetch service names for the top services
    const serviceIds = topServicesGrouped.map(g => g.serviceId)
    const services = await prisma.labService.findMany({
      where: {
        id: { in: serviceIds }
      },
      select: {
        id: true,
        name: true
      }
    })

    const serviceMap = new Map(services.map(s => [s.id, s.name]))

    const topServices = topServicesGrouped.map(group => ({
      serviceId: group.serviceId,
      serviceName: serviceMap.get(group.serviceId) || 'Unknown Service',
      revenue: group._sum.quotedPrice ? Number(group._sum.quotedPrice) : 0,
      orderCount: group._count.id
    }))

    // ========================================================================
    // 10. RETURN ANALYTICS DATA
    // ========================================================================
    return NextResponse.json({
      revenue: {
        total: totalRevenue,
        monthlyBreakdown: monthlyRevenue,
        growth: revenueGrowth
      },
      quotes: {
        totalQuotes: totalQuotes,
        acceptedQuotes: acceptedQuotesCount,
        acceptanceRate,
        avgQuotePrice,
        pendingQuotes: pendingQuotesCount
      },
      orders: {
        totalOrders: totalOrders,
        completedOrders: completedOrdersCount,
        inProgressOrders: inProgressOrdersCount,
        monthlyVolume
      },
      topServices
    })
  } catch (error) {
    console.error('Analytics error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Order type for analytics calculations
 */
interface AnalyticsOrder {
  createdAt: Date
  quotedPrice: Decimal | null
  status?: OrderStatus // Add status here if needed, or keep it loosely typed
}

/**
 * Calculate monthly breakdown of revenue and order count
 * Returns last N months of data with zero-filled gaps
 */
function calculateMonthlyBreakdown(
  orders: AnalyticsOrder[],
  months: number
): Array<{ month: string; revenue: number; orderCount: number }> {
  const monthlyData: { [key: string]: MonthlyDataEntry } = {}

  // Initialize last N months with zero values
  const now = new Date()
  for (let i = months - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    monthlyData[monthKey] = { revenue: 0, orderCount: 0 }
  }

  // Aggregate orders by month
  orders.forEach((order: AnalyticsOrder): void => {
    const orderDate = new Date(order.createdAt)
    const monthKey = `${orderDate.getFullYear()}-${String(orderDate.getMonth() + 1).padStart(2, '0')}`

    if (monthlyData[monthKey]) {
      monthlyData[monthKey].revenue += order.quotedPrice ? Number(order.quotedPrice) : 0
      monthlyData[monthKey].orderCount += 1
    }
  })

  // Convert to array format and sort by month
  return Object.entries(monthlyData)
    .map(([month, data]: [string, MonthlyDataEntry]) => ({
      month,
      revenue: data.revenue,
      orderCount: data.orderCount
    }))
    .sort((a: { month: string }, b: { month: string }): number =>
      a.month.localeCompare(b.month)
    )
}

/**
 * Calculate monthly volume (order count per month)
 * Returns last N months with zero-filled gaps
 */
function calculateMonthlyVolume(
  orders: AnalyticsOrder[],
  months: number
): Array<{ month: string; orderCount: number }> {
  const monthlyData: { [key: string]: number } = {}

  // Initialize last N months
  const now = new Date()
  for (let i = months - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    monthlyData[monthKey] = 0
  }

  // Count orders by month
  orders.forEach((order: AnalyticsOrder): void => {
    const orderDate = new Date(order.createdAt)
    const monthKey = `${orderDate.getFullYear()}-${String(orderDate.getMonth() + 1).padStart(2, '0')}`

    if (monthlyData[monthKey]) {
      monthlyData[monthKey] += 1
    }
  })

  // Convert to array format and sort
  return Object.entries(monthlyData)
    .map(([month, orderCount]: [string, number]) => ({
      month,
      orderCount
    }))
    .sort((a: { month: string }, b: { month: string }): number =>
      a.month.localeCompare(b.month)
    )
}
