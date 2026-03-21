/**
 * Revenue Chart Component
 *
 * Displays monthly revenue trends with dual-axis visualization:
 * - Revenue (₱) on left axis (green line)
 * - Order count on right axis (blue line)
 *
 * Used in lab analytics dashboard for pricing optimization and growth tracking.
 */

'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { formatCurrency } from '@/lib/utils'

interface RevenueChartProps {
  data: {
    month: string       // "2024-01" format
    revenue: number     // Total revenue for month
    orderCount: number  // Number of orders for month
  }[]
  loading?: boolean
}

export function RevenueChart({ data, loading }: RevenueChartProps) {
  // Loading state
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Revenue Trends</CardTitle>
          <CardDescription>Monthly revenue over time</CardDescription>
        </CardHeader>
        <CardContent className="h-80 flex items-center justify-center">
          <div className="text-gray-500">Loading chart data...</div>
        </CardContent>
      </Card>
    )
  }

  // Empty state
  if (!data || data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Revenue Trends</CardTitle>
          <CardDescription>No revenue data available</CardDescription>
        </CardHeader>
        <CardContent className="h-80 flex items-center justify-center">
          <div className="text-center">
            <p className="text-gray-500">No completed orders yet</p>
            <p className="text-sm text-gray-400 mt-2">
              Revenue data will appear once orders are completed
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Format data for chart display
  const chartData = data.map(item => ({
    month: formatMonthLabel(item.month),
    revenue: item.revenue,
    orderCount: item.orderCount
  }))

  // Calculate total revenue for display
  const totalRevenue = data.reduce((sum, item) => sum + item.revenue, 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue Trends</CardTitle>
        <CardDescription>
          Total revenue: {formatCurrency(totalRevenue)} across {chartData.length} months
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e0e0e0" />
            <XAxis
              dataKey="month"
              stroke="#666"
              tick={{ fontSize: 12 }}
              angle={-45}
              textAnchor="end"
              height={80}
            />
            <YAxis
              stroke="#666"
              tick={{ fontSize: 12 }}
              tickFormatter={(value) => `₱${(value / 1000).toFixed(0)}k`}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke="#666"
              tick={{ fontSize: 12 }}
            />
            <Tooltip
              content={<CustomTooltip />}
              cursor={{ stroke: '#666', strokeDasharray: '3 3' }}
            />
            <Legend
              wrapperStyle={{ paddingTop: '20px' }}
              iconType="line"
            />
            <Line
              type="monotone"
              dataKey="revenue"
              stroke="#10b981"
              strokeWidth={2}
              dot={{ fill: '#10b981', r: 4 }}
              activeDot={{ r: 6 }}
              name="Revenue (₱)"
            />
            <Line
              type="monotone"
              dataKey="orderCount"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={{ fill: '#3b82f6', r: 4 }}
              activeDot={{ r: 6 }}
              name="Orders"
              yAxisId="right"
            />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}

/**
 * Helper: Format month label
 * Converts "2024-01" to "Jan 2024"
 */
function formatMonthLabel(monthStr: string): string {
  const [year, month] = monthStr.split('-')
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const monthIndex = parseInt(month, 10) - 1
  return `${monthNames[monthIndex]} ${year}`
}

/**
 * Chart data point interface for tooltip
 */
interface ChartDataPoint {
  month: string
  revenue: number
  orderCount: number
}

/**
 * Custom tooltip props interface
 */
interface CustomTooltipProps {
  active?: boolean
  payload?: Array<{
    payload: ChartDataPoint
  }>
}

/**
 * Custom tooltip component
 * Displays revenue and order count on hover
 */
function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload || !payload.length) return null

  const data = payload[0].payload

  return (
    <div className="bg-white p-4 border border-gray-200 rounded-lg shadow-lg">
      <p className="font-semibold text-gray-900 mb-2">{data.month}</p>
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-green-500"></div>
          <span className="text-sm text-gray-600">Revenue:</span>
          <span className="font-semibold text-gray-900">{formatCurrency(data.revenue)}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-blue-500"></div>
          <span className="text-sm text-gray-600">Orders:</span>
          <span className="font-semibold text-gray-900">{data.orderCount}</span>
        </div>
      </div>
    </div>
  )
}
