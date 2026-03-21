/**
 * QuoteMetrics Component - Usage Examples
 * ========================================
 *
 * This file demonstrates how to use the QuoteMetrics component
 * in different scenarios.
 */

import { QuoteMetrics } from './QuoteMetrics'

// Example 1: Excellent Performance (≥75% acceptance)
export function ExcellentPerformanceExample() {
  return (
    <QuoteMetrics
      data={{
        totalQuotes: 50,
        acceptedQuotes: 40,
        acceptanceRate: 80,
        avgQuotePrice: 15000,
        pendingQuotes: 5
      }}
    />
  )
}

// Example 2: Good Performance (50-74% acceptance)
export function GoodPerformanceExample() {
  return (
    <QuoteMetrics
      data={{
        totalQuotes: 30,
        acceptedQuotes: 18,
        acceptanceRate: 60,
        avgQuotePrice: 12000,
        pendingQuotes: 8
      }}
    />
  )
}

// Example 3: Needs Work (<50% acceptance)
export function NeedsWorkExample() {
  return (
    <QuoteMetrics
      data={{
        totalQuotes: 20,
        acceptedQuotes: 6,
        acceptanceRate: 30,
        avgQuotePrice: 18000,
        pendingQuotes: 10
      }}
    />
  )
}

// Example 4: Loading State
export function LoadingExample() {
  return <QuoteMetrics data={{
    totalQuotes: 0,
    acceptedQuotes: 0,
    acceptanceRate: 0,
    avgQuotePrice: 0,
    pendingQuotes: 0
  }} loading={true} />
}

// Example 5: Empty State (No Quotes Yet)
export function EmptyStateExample() {
  return (
    <QuoteMetrics
      data={{
        totalQuotes: 0,
        acceptedQuotes: 0,
        acceptanceRate: 0,
        avgQuotePrice: 0,
        pendingQuotes: 0
      }}
    />
  )
}

// Example 6: Real-world Integration with API
export async function RealWorldExample() {
  // Fetch data from analytics API
  const response = await fetch('/api/analytics?timeframe=last30days')
  const data = await response.json()

  return <QuoteMetrics data={data.quotes} />
}

/**
 * Visual Appearance Reference
 * ============================
 *
 * Desktop (4 columns):
 * ┌──────────────┬──────────────┬──────────────┬──────────────┐
 * │ Total Quotes │ Accept Rate  │ Avg Price    │ Pending      │
 * │ 50           │ 80.0% ✅     │ ₱15,000.00   │ 5            │
 * │              │ Excellent    │              │ 10% of total │
 * └──────────────┴──────────────┴──────────────┴──────────────┘
 *
 * Tablet (2 columns):
 * ┌──────────────┬──────────────┐
 * │ Total Quotes │ Accept Rate  │
 * ├──────────────┼──────────────┤
 * │ Avg Price    │ Pending      │
 * └──────────────┴──────────────┘
 *
 * Mobile (1 column):
 * ┌──────────────┐
 * │ Total Quotes │
 * ├──────────────┤
 * │ Accept Rate  │
 * ├──────────────┤
 * │ Avg Price    │
 * ├──────────────┤
 * │ Pending      │
 * └──────────────┘
 *
 * Performance Indicators:
 * - ≥75%: Green TrendingUp icon + "Excellent" badge (green)
 * - 50-74%: Yellow CheckCircle icon + "Good" badge (yellow)
 * - <50%: Red TrendingDown icon + "Needs Work" badge (red)
 */
