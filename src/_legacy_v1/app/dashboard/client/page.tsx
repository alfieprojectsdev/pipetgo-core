'use client'

import { useSession, signOut } from 'next-auth/react'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { formatCurrency, formatDate, getStatusColor, getStatusDisplayName } from '@/lib/utils'
import { OrderStatus } from '@/types'
import { toast } from '@/lib/toast'
import { ErrorBoundary } from '@/components/ErrorBoundary'

export const dynamic = 'force-dynamic'

interface Attachment {
  id: string
  orderId: string
  uploadedById: string
  fileName: string
  fileUrl: string
  fileType: string
  fileSize: number | null
  attachmentType: string
  createdAt: string
}

interface Order {
  id: string
  status: string
  createdAt: string
  quotedPrice?: number | null
  quotedAt?: string | null
  quoteNotes?: string | null
  service: { name: string; category: string }
  lab: { name: string }
  attachments: Attachment[]
}

export default function ClientDashboard() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [orders, setOrders] = useState<Order[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [approvalDialogOpen, setApprovalDialogOpen] = useState(false)
  const [rejectionDialogOpen, setRejectionDialogOpen] = useState(false)
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null)
  const [rejectionReason, setRejectionReason] = useState('')
  const [rejectionError, setRejectionError] = useState('')

  useEffect(() => {
    if (status === 'loading') return
    if (!session || session.user.role !== 'CLIENT') {
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

  const openApprovalDialog = (orderId: string) => {
    setSelectedOrderId(orderId)
    setApprovalDialogOpen(true)
  }

  const confirmApproval = async () => {
    if (!selectedOrderId) return

    try {
      const response = await fetch(`/api/orders/${selectedOrderId}/approve-quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: true })
      })

      if (response.ok) {
        toast.success('Quote approved', 'Order is now pending')
        setApprovalDialogOpen(false)
        fetchOrders()
      } else {
        const data = await response.json()
        toast.error('Failed to approve quote', data.error)
      }
    } catch (error) {
      console.error('Error approving quote:', error)
      toast.error('An error occurred', 'Please try again')
    }
  }

  const openRejectionDialog = (orderId: string) => {
    setSelectedOrderId(orderId)
    setRejectionReason('')
    setRejectionError('')
    setRejectionDialogOpen(true)
  }

  const confirmRejection = async () => {
    if (!selectedOrderId) return

    if (rejectionReason.trim().length < 10) {
      setRejectionError('Rejection reason must be at least 10 characters')
      return
    }

    try {
      const response = await fetch(`/api/orders/${selectedOrderId}/approve-quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: false, rejectionReason: rejectionReason })
      })

      if (response.ok) {
        toast.success('Quote rejected', 'Lab has been notified')
        setRejectionDialogOpen(false)
        fetchOrders()
      } else {
        const data = await response.json()
        toast.error('Failed to reject quote', data.error)
      }
    } catch (error) {
      console.error('Error rejecting quote:', error)
      toast.error('An error occurred', 'Please try again')
    }
  }

  // Status functions removed - using centralized getStatusColor() and getStatusDisplayName() from utils.ts

  if (status === 'loading' || isLoading) {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>
  }

  const selectedOrder = orders.find(o => o.id === selectedOrderId)

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Client Dashboard</h1>
              <p className="text-gray-600 text-sm sm:text-base">Welcome, {session?.user?.name}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => router.push('/')}
                className="text-sm sm:text-base"
              >
                Browse Services
              </Button>
              <Button
                variant="outline"
                onClick={() => signOut({ callbackUrl: '/' })}
                className="text-sm sm:text-base"
              >
                Sign Out
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4">Your Test Requests</h2>
          
          {orders.length === 0 ? (
            <Card>
              <CardContent className="text-center py-12">
                <p className="text-gray-500 mb-4">No test requests yet</p>
                <Button onClick={() => router.push('/')}>
                  Browse Available Services
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4">
              {orders.map((order) => (
                <Card key={order.id}>
                  <CardHeader className="pb-3">
                    <div className="flex justify-between items-start gap-4">
                      <div className="min-w-0 flex-1">
                        {/* v0.app UX: Lab name at top for quick scanning */}
                        <CardTitle className="text-base font-bold text-gray-900 truncate">
                          {order.lab.name}
                        </CardTitle>
                        <CardDescription className="text-sm text-gray-600 mt-1">
                          {order.service.name} • {order.service.category}
                        </CardDescription>
                      </div>
                      <span
                        className={`px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap ${getStatusColor(order.status as OrderStatus)}`}
                        role="status"
                        aria-label={`Order status: ${getStatusDisplayName(order.status as OrderStatus)}`}
                      >
                        {getStatusDisplayName(order.status as OrderStatus)}
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      <div className="grid md:grid-cols-3 gap-4">
                        <div>
                          <p className="text-sm text-gray-600">Submitted</p>
                          <p className="font-medium">{formatDate(order.createdAt)}</p>
                        </div>
                        <div>
                          <p className="text-sm text-gray-600">Quoted Price</p>
                          <p className="font-medium">
                            {order.quotedPrice ? formatCurrency(order.quotedPrice) : 'Awaiting quote'}
                          </p>
                        </div>
                        <div>
                          <p className="text-sm text-gray-600">Results</p>
                          {order.status === 'COMPLETED' && order.attachments.length > 0 ? (
                            <Button size="sm" variant="outline">
                              Download Results
                            </Button>
                          ) : (
                            <p className="text-gray-500">Not available</p>
                          )}
                        </div>
                      </div>

                      {/* Quote Details */}
                      {order.status === 'QUOTE_PROVIDED' && order.quotedPrice && (
                        <div className="border-t pt-4">
                          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                            <div className="flex justify-between items-start mb-4">
                              <div>
                                <p className="font-semibold text-green-900">Quote Ready for Review</p>
                                <p className="text-sm text-green-700 mt-1">
                                  Lab has provided a quote of {formatCurrency(order.quotedPrice)}
                                </p>
                                {order.quotedAt && (
                                  <p className="text-xs text-green-600 mt-1">
                                    Quoted on {formatDate(order.quotedAt)}
                                  </p>
                                )}
                                {order.quoteNotes && (
                                  <div className="mt-2">
                                    <p className="text-sm font-medium text-green-900">Notes from lab:</p>
                                    <p className="text-sm text-green-800 mt-1">{order.quoteNotes}</p>
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="flex flex-col sm:flex-row gap-2">
                              <Button
                                size="sm"
                                onClick={() => openApprovalDialog(order.id)}
                                className="bg-green-600 hover:bg-green-700 text-white focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 w-full sm:w-auto min-h-[44px]"
                              >
                                Approve Quote
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => openRejectionDialog(order.id)}
                                className="border-red-300 text-red-700 hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 w-full sm:w-auto min-h-[44px]"
                              >
                                Reject Quote
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-green-600">
                {orders.length}
              </div>
              <p className="text-sm text-gray-600">Total Requests</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-yellow-600">
                {orders.filter(o => o.status === 'PENDING').length}
              </div>
              <p className="text-sm text-gray-600">Pending</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-purple-600">
                {orders.filter(o => o.status === 'IN_PROGRESS').length}
              </div>
              <p className="text-sm text-gray-600">In Progress</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <div className="text-2xl font-bold text-green-600">
                {orders.filter(o => o.status === 'COMPLETED').length}
              </div>
              <p className="text-sm text-gray-600">Completed</p>
            </CardContent>
          </Card>
        </div>
      </main>

      {/* Approval Dialog */}
      <Dialog open={approvalDialogOpen} onOpenChange={setApprovalDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve Quote</DialogTitle>
            <DialogDescription>
              Are you sure you want to approve this quote for {selectedOrder && selectedOrder.quotedPrice && formatCurrency(selectedOrder.quotedPrice)}
              and proceed with testing?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApprovalDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-green-600 hover:bg-green-700 text-white focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2"
              onClick={confirmApproval}
            >
              Approve Quote
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rejection Dialog */}
      <Dialog open={rejectionDialogOpen} onOpenChange={setRejectionDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject Quote</DialogTitle>
            <DialogDescription>
              Please provide a reason for rejecting this quote (minimum 10 characters)
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Textarea
              id="rejectionReason"
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="Enter your reason for rejection..."
              rows={4}
              aria-describedby={rejectionError ? "rejection-error" : undefined}
              aria-invalid={!!rejectionError}
            />
            {rejectionError && (
              <p id="rejection-error" className="text-sm text-red-600 mt-1" role="alert">
                {rejectionError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectionDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmRejection}
            >
              Reject Quote
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
    </ErrorBoundary>
  )
}