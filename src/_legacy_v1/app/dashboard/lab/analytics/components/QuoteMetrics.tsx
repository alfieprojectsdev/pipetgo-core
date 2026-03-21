/**
 * Quote Metrics Cards Component
 * ==============================
 * Displays key performance indicators for quote management:
 * - Total quotes provided
 * - Acceptance rate with performance indicators
 * - Average quote price for accepted quotes
 * - Pending quotes awaiting client approval
 *
 * Visual Design:
 * - Responsive grid (4/2/1 columns for desktop/tablet/mobile)
 * - Color-coded acceptance rate (green ≥75%, yellow 50-74%, red <50%)
 * - Loading skeleton for async data
 * - Empty state for new labs
 */

'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { TrendingUp, TrendingDown, CheckCircle, Clock, DollarSign, FileText } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'

interface QuoteMetricsProps {
  data: {
    totalQuotes: number        // All quotes provided
    acceptedQuotes: number     // Quotes that led to orders
    acceptanceRate: number     // Percentage (0-100)
    avgQuotePrice: number      // Average price of accepted quotes
    pendingQuotes: number      // Quotes awaiting client approval
  }
  loading?: boolean
}

export function QuoteMetrics({ data, loading }: QuoteMetricsProps) {
  // Loading state with skeleton cards
  if (loading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map(i => (
          <Card key={i}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Loading...</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-8 bg-gray-200 animate-pulse rounded"></div>
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  const { totalQuotes, acceptedQuotes, acceptanceRate, avgQuotePrice, pendingQuotes } = data

  // Empty state when no quotes provided yet
  if (totalQuotes === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Quote Performance</CardTitle>
          <CardDescription>No quotes yet</CardDescription>
        </CardHeader>
        <CardContent className="py-8">
          <div className="text-center text-gray-500">
            <p>No quotes provided yet</p>
            <p className="text-sm text-gray-400 mt-2">
              Quote performance metrics will appear once you provide quotes to clients
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Calculate rejection rate for insights
  const rejectedQuotes = totalQuotes - acceptedQuotes - pendingQuotes
  const rejectionRate = totalQuotes > 0 ? (rejectedQuotes / totalQuotes) * 100 : 0

  // Determine acceptance rate performance level
  const isExcellent = acceptanceRate >= 75
  const isGood = acceptanceRate >= 50 && acceptanceRate < 75
  const needsWork = acceptanceRate < 50

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {/* Card 1: Total Quotes */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Total Quotes</CardTitle>
          <FileText className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{totalQuotes}</div>
          <p className="text-xs text-muted-foreground mt-1">
            All quotes provided to clients
          </p>
        </CardContent>
      </Card>

      {/* Card 2: Acceptance Rate */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Acceptance Rate</CardTitle>
          {isExcellent ? (
            <TrendingUp className="h-4 w-4 text-green-600" />
          ) : isGood ? (
            <CheckCircle className="h-4 w-4 text-yellow-600" />
          ) : (
            <TrendingDown className="h-4 w-4 text-red-600" />
          )}
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-bold">{acceptanceRate.toFixed(1)}%</div>
            <Badge
              variant={isExcellent ? "success" : isGood ? "warning" : "error"}
              className="text-xs"
            >
              {isExcellent ? "Excellent" : isGood ? "Good" : "Needs Work"}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {acceptedQuotes} of {totalQuotes} quotes accepted
          </p>
        </CardContent>
      </Card>

      {/* Card 3: Average Quote Price */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Avg Quote Price</CardTitle>
          <DollarSign className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{formatCurrency(avgQuotePrice)}</div>
          <p className="text-xs text-muted-foreground mt-1">
            Based on accepted quotes
          </p>
        </CardContent>
      </Card>

      {/* Card 4: Pending Quotes */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Pending Quotes</CardTitle>
          <Clock className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline gap-2">
            <div className="text-2xl font-bold">{pendingQuotes}</div>
            {pendingQuotes > 0 && (
              <Badge variant="default" className="text-xs">
                {((pendingQuotes / totalQuotes) * 100).toFixed(0)}% of total
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Awaiting client approval
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
