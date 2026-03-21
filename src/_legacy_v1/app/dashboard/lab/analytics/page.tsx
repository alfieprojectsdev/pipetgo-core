/**
 * Analytics Dashboard Page
 *
 * Provides comprehensive revenue insights and performance metrics for lab admins.
 * Displays quote performance, revenue trends, order volume, and top services.
 */

'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { Card, CardContent } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import {
  RevenueChart,
  QuoteMetrics,
  OrderVolumeChart,
  TopServicesTable
} from './components'
import type { AnalyticsData } from '@/types'
import { ErrorBoundary } from '@/components/ErrorBoundary'

export const dynamic = 'force-dynamic'

export default function AnalyticsPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [analyticsData, setAnalyticsData] = useState<AnalyticsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [timeframe, setTimeframe] = useState<string>('last30days')

  // Authentication check
  useEffect(() => {
    if (status === 'loading') return
    if (!session || session.user.role !== 'LAB_ADMIN') {
      router.push('/auth/signin')
    }
  }, [session, status, router])

  // Fetch analytics data
  useEffect(() => {
    if (session?.user) {
      fetchAnalytics()
    }
  }, [session, timeframe])

  async function fetchAnalytics() {
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`/api/analytics?timeframe=${timeframe}`)

      if (!res.ok) {
        throw new Error('Failed to fetch analytics')
      }

      const data = await res.json()
      setAnalyticsData(data)
    } catch (err) {
      setError('Failed to load analytics data')
      console.error('Analytics fetch error:', err)
    } finally {
      setLoading(false)
    }
  }

  if (status === 'loading' || !session) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray-500">Loading...</div>
      </div>
    )
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Analytics Dashboard</h1>
              <p className="text-gray-600">Revenue insights and performance metrics</p>
            </div>

            {/* Timeframe Selector */}
            <Select
              value={timeframe}
              onChange={(e) => setTimeframe(e.target.value)}
              className="w-48"
            >
              <option value="last30days">Last 30 Days</option>
              <option value="last90days">Last 90 Days</option>
              <option value="thisYear">This Year</option>
              <option value="allTime">All Time</option>
            </Select>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {error && (
          <Card className="mb-6 bg-red-50 border-red-200">
            <CardContent className="py-4">
              <p className="text-red-600">{error}</p>
            </CardContent>
          </Card>
        )}

        <div className="space-y-6">
          {/* Quote Performance Metrics */}
          <QuoteMetrics
            data={analyticsData?.quotes || {
              totalQuotes: 0,
              acceptedQuotes: 0,
              acceptanceRate: 0,
              avgQuotePrice: 0,
              pendingQuotes: 0
            }}
            loading={loading}
          />

          {/* Revenue Trends Chart */}
          <RevenueChart
            data={analyticsData?.revenue.monthlyBreakdown || []}
            loading={loading}
          />

          {/* Order Volume Chart */}
          <OrderVolumeChart
            data={analyticsData?.orders.monthlyVolume || []}
            loading={loading}
          />

          {/* Top Services Table */}
          <TopServicesTable
            data={analyticsData?.topServices || []}
            loading={loading}
          />
        </div>
      </main>
    </div>
    </ErrorBoundary>
  )
}
