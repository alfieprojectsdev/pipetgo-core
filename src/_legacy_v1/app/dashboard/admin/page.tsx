'use client'

import { useSession, signOut } from 'next-auth/react'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatCurrency, formatDate } from '@/lib/utils'
import { ErrorBoundary } from '@/components/ErrorBoundary'

export const dynamic = 'force-dynamic'

interface Order {
  id: string
  status: string
  createdAt: string
  quotedPrice?: number
  client: { name: string; email: string }
  service: { name: string; category: string }
  lab: { name: string }
}

export default function AdminDashboard() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [orders, setOrders] = useState<Order[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (status === 'loading') return
    if (!session || session.user.role !== 'ADMIN') {
      router.push('/auth/signin')
      return
    }
    fetchOrders()
  }, [session, status, router])

  const fetchOrders = async () => {
    try {
      const response = await fetch('/api/orders')
      if (response.ok) {
        const data = await response.json()
        setOrders(data)
      }
    } catch (error) {
      console.error('Error fetching orders:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const getStatusColor = (status: string) => {
    const colors = {
      PENDING: 'bg-yellow-100 text-yellow-800',
      ACKNOWLEDGED: 'bg-green-100 text-green-800',
      IN_PROGRESS: 'bg-purple-100 text-purple-800',
      COMPLETED: 'bg-green-100 text-green-800',
      CANCELLED: 'bg-red-100 text-red-800'
    }
    return colors[status as keyof typeof colors] || 'bg-gray-100 text-gray-800'
  }

  const totalRevenue = orders
    .filter(o => o.status === 'COMPLETED' && o.quotedPrice)
    .reduce((sum, order) => sum + (Number(order.quotedPrice) || 0), 0)

  const categoryStats = orders.reduce((acc: Record<string, number>, order) => {
    acc[order.service.category] = (acc[order.service.category] || 0) + 1
    return acc
  }, {})

  if (status === 'loading' || isLoading) {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Admin Dashboard</h1>
              <p className="text-gray-600">PipetGo! Platform Overview</p>
            </div>
            <Button 
              variant="outline" 
              onClick={() => signOut({ callbackUrl: '/' })}
            >
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Overview Stats */}
        <div className="grid md:grid-cols-4 gap-4 mb-8">
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-green-600">
                {orders.length}
              </div>
              <p className="text-sm text-gray-600">Total Orders</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-green-600">
                {formatCurrency(totalRevenue)}
              </div>
              <p className="text-sm text-gray-600">Revenue (Completed)</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-purple-600">
                {Object.keys(categoryStats).length}
              </div>
              <p className="text-sm text-gray-600">Service Categories</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-orange-600">
                {orders.filter(o => o.status === 'COMPLETED').length}
              </div>
              <p className="text-sm text-gray-600">Completed Orders</p>
            </CardContent>
          </Card>
        </div>

        {/* Recent Activity */}
        <div className="grid lg:grid-cols-2 gap-8">
          <Card>
            <CardHeader>
              <CardTitle>Recent Orders</CardTitle>
              <CardDescription>Latest order activity across all labs</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {orders.slice(0, 5).map((order) => (
                  <div key={order.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-b-0">
                    <div>
                      <p className="font-medium">{order.service.name}</p>
                      <p className="text-sm text-gray-600">{order.client.name} • {order.lab.name}</p>
                    </div>
                    <div className="text-right">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(order.status)}`}>
                        {order.status}
                      </span>
                      <p className="text-xs text-gray-500 mt-1">{formatDate(order.createdAt)}</p>
                    </div>
                  </div>
                ))}
                {orders.length === 0 && (
                  <p className="text-gray-500 text-center py-4">No orders yet</p>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Service Categories</CardTitle>
              <CardDescription>Distribution of orders by category</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {Object.entries(categoryStats).map(([category, count]) => (
                  <div key={category} className="flex items-center justify-between">
                    <span className="text-sm font-medium">{category}</span>
                    <div className="flex items-center space-x-2">
                      <div className="bg-green-100 rounded-full px-2 py-1">
                        <span className="text-xs font-medium text-green-800">{count}</span>
                      </div>
                    </div>
                  </div>
                ))}
                {Object.keys(categoryStats).length === 0 && (
                  <p className="text-gray-500 text-center py-4">No categories yet</p>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* All Orders Table */}
        <Card className="mt-8">
          <CardHeader>
            <CardTitle>All Orders</CardTitle>
            <CardDescription>Complete order history and status monitoring</CardDescription>
          </CardHeader>
          <CardContent>
            {orders.length === 0 ? (
              <div className="text-center py-12">
                <div className="text-4xl mb-4" aria-hidden="true">📊</div>
                <h3 className="text-lg font-medium text-gray-900 mb-2">No platform activity yet</h3>
                <p className="text-gray-500">Orders will appear here as users submit requests.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="text-left py-2">Order ID</th>
                      <th className="text-left py-2">Client</th>
                      <th className="text-left py-2">Service</th>
                      <th className="text-left py-2">Lab</th>
                      <th className="text-left py-2">Status</th>
                      <th className="text-left py-2">Price</th>
                      <th className="text-left py-2">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((order) => (
                      <tr key={order.id} className="border-b hover:bg-gray-50">
                        <td className="py-2 font-mono text-xs">
                          #{order.id.substring(0, 8)}
                        </td>
                        <td className="py-2">{order.client.name}</td>
                        <td className="py-2">
                          <div>
                            <p className="font-medium">{order.service.name}</p>
                            <p className="text-xs text-gray-500">{order.service.category}</p>
                          </div>
                        </td>
                        <td className="py-2">{order.lab.name}</td>
                        <td className="py-2">
                          <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(order.status)}`}>
                            {order.status.replace('_', ' ')}
                          </span>
                        </td>
                        <td className="py-2">
                          {order.quotedPrice ? formatCurrency(order.quotedPrice) : '-'}
                        </td>
                        <td className="py-2 text-xs text-gray-600">
                          {formatDate(order.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
    </ErrorBoundary>
  )
}