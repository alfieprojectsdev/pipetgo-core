/**
 * Top Services Table Component
 *
 * Displays top performing services by revenue with rankings,
 * order counts, and revenue percentages.
 */

'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Award } from 'lucide-react'
import { formatCurrency } from '@/lib/utils'

interface TopServicesTableProps {
  data: {
    serviceId: string
    serviceName: string
    revenue: number
    orderCount: number
  }[]
  loading?: boolean
}

export function TopServicesTable({ data, loading }: TopServicesTableProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Top Services</CardTitle>
          <CardDescription>Loading service performance data...</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="h-12 bg-gray-200 animate-pulse rounded"></div>
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!data || data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Top Services</CardTitle>
          <CardDescription>No service data available</CardDescription>
        </CardHeader>
        <CardContent className="py-8">
          <div className="text-center text-gray-500">
            <p>No completed orders yet</p>
            <p className="text-sm text-gray-400 mt-2">
              Service performance data will appear once orders are completed
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Calculate total revenue for percentage calculation
  const totalRevenue = data.reduce((sum, item) => sum + item.revenue, 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top Services by Revenue</CardTitle>
        <CardDescription>
          Top {data.length} performing services | Total revenue: {formatCurrency(totalRevenue)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">Rank</TableHead>
              <TableHead>Service Name</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="text-right">Orders</TableHead>
              <TableHead className="text-right">Avg/Order</TableHead>
              <TableHead className="text-right">% of Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((service, index) => {
              const avgPerOrder = service.orderCount > 0
                ? service.revenue / service.orderCount
                : 0
              const percentOfTotal = totalRevenue > 0
                ? (service.revenue / totalRevenue) * 100
                : 0

              return (
                <TableRow key={service.serviceId}>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      {index === 0 && (
                        <Award className="h-4 w-4 text-yellow-500" />
                      )}
                      <span className="font-medium">#{index + 1}</span>
                    </div>
                  </TableCell>
                  <TableCell className="font-medium">
                    {service.serviceName}
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    {formatCurrency(service.revenue)}
                  </TableCell>
                  <TableCell className="text-right">
                    {service.orderCount}
                  </TableCell>
                  <TableCell className="text-right text-gray-600">
                    {formatCurrency(avgPerOrder)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge variant="info">
                      {percentOfTotal.toFixed(1)}%
                    </Badge>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
