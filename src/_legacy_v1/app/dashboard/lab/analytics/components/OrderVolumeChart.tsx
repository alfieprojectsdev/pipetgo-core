/**
 * Order Volume Chart Component
 *
 * Displays monthly order volume trends with bar chart visualization.
 * Highlights peak month in green to identify busy periods.
 *
 * Used in lab analytics dashboard for capacity planning and growth tracking.
 */

'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell } from 'recharts'

interface OrderVolumeChartProps {
  data: {
    month: string       // "2024-01" format
    orderCount: number  // Number of orders for month
  }[]
  loading?: boolean
}

export function OrderVolumeChart({ data, loading }: OrderVolumeChartProps) {
  // Loading state
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Order Volume</CardTitle>
          <CardDescription>Monthly order trends</CardDescription>
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
          <CardTitle>Order Volume</CardTitle>
          <CardDescription>No order data available</CardDescription>
        </CardHeader>
        <CardContent className="h-80 flex items-center justify-center">
          <div className="text-center">
            <p className="text-gray-500">No orders yet</p>
            <p className="text-sm text-gray-400 mt-2">
              Order volume data will appear once clients start placing orders
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Calculate statistics
  const totalOrders = data.reduce((sum, item) => sum + item.orderCount, 0)
  const avgOrders = (totalOrders / data.length).toFixed(1)
  const peakMonth = data.reduce((max, item) =>
    item.orderCount > max.orderCount ? item : max
  , data[0])

  // Format data for chart display
  const chartData = data.map(item => ({
    month: formatMonthLabel(item.month),  // "2024-01" → "Jan 2024"
    rawMonth: item.month,  // Keep for comparison
    orderCount: item.orderCount
  }))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Order Volume</CardTitle>
        <CardDescription>
          Total: {totalOrders} orders | Average: {avgOrders} orders/month | Peak: {formatMonthLabel(peakMonth.month)} ({peakMonth.orderCount} orders)
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
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
              allowDecimals={false}
            />
            <Tooltip
              content={<CustomTooltip />}
              cursor={{ fill: 'rgba(59, 130, 246, 0.1)' }}
            />
            <Legend
              wrapperStyle={{ paddingTop: '20px' }}
              iconType="rect"
            />
            <Bar
              dataKey="orderCount"
              fill="#3b82f6"  // Blue
              radius={[8, 8, 0, 0]}  // Rounded top corners
              name="Orders"
            >
              {chartData.map((entry, index) => {
                // Highlight peak month with different color
                const isPeak = entry.rawMonth === peakMonth.month
                return (
                  <Cell
                    key={`cell-${index}`}
                    fill={isPeak ? '#10b981' : '#3b82f6'}  // Green for peak, blue for others
                  />
                )
              })}
            </Bar>
          </BarChart>
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
  rawMonth: string
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
 * Displays order count on hover
 */
function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload || !payload.length) return null

  const data = payload[0].payload

  return (
    <div className="bg-white p-4 border border-gray-200 rounded-lg shadow-lg">
      <p className="font-semibold text-gray-900 mb-2">{data.month}</p>
      <div className="flex items-center gap-2">
        <div className="w-3 h-3 rounded bg-blue-500"></div>
        <span className="text-sm text-gray-600">Orders:</span>
        <span className="font-semibold text-gray-900">{data.orderCount}</span>
      </div>
    </div>
  )
}
