'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { toast } from 'sonner'

interface OrderDetails {
  id: string
  service: {
    name: string
    category: string
  }
  client: {
    name: string
    email: string
  }
  sampleDescription: string
  specialInstructions?: string
  createdAt: string
}

export default function QuoteProvisionPage({ params }: { params: { id: string } }) {
  const router = useRouter()
  const [order, setOrder] = useState<OrderDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [quotedPrice, setQuotedPrice] = useState('')
  const [estimatedTurnaroundDays, setEstimatedTurnaroundDays] = useState('')
  const [quoteNotes, setQuoteNotes] = useState('')

  const [formErrors, setFormErrors] = useState<Record<string, string>>({})

  // Fetch order details on mount
  useState(() => {
    async function fetchOrder() {
      try {
        const res = await fetch(`/api/orders/${params.id}`)
        if (!res.ok) {
          throw new Error('Failed to fetch order')
        }
        const data = await res.json()
        setOrder(data)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to fetch order'
        setError(message)
      } finally {
        setLoading(false)
      }
    }
    fetchOrder()
  })

  function validateForm(): boolean {
    const errors: Record<string, string> = {}

    if (!quotedPrice || parseFloat(quotedPrice) <= 0) {
      errors.quotedPrice = 'Price must be a positive number'
    }

    if (estimatedTurnaroundDays && (parseInt(estimatedTurnaroundDays) <= 0 || !Number.isInteger(parseFloat(estimatedTurnaroundDays)))) {
      errors.estimatedTurnaroundDays = 'Turnaround days must be a positive integer'
    }

    setFormErrors(errors)
    return Object.keys(errors).length === 0
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    if (!validateForm()) {
      return
    }

    setSubmitting(true)
    setError(null)

    try {
      const res = await fetch(`/api/orders/${params.id}/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quotedPrice: parseFloat(quotedPrice),
          estimatedTurnaroundDays: estimatedTurnaroundDays ? parseInt(estimatedTurnaroundDays) : undefined,
          quoteNotes: quoteNotes || undefined
        })
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to submit quote')
      }

      toast.success('Quote submitted successfully', {
        description: 'The client will be notified of your quote.'
      })

      // Delay redirect to allow toast announcement
      setTimeout(() => {
        router.push('/dashboard/lab')
        router.refresh()
      }, 1500)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to submit quote'
      setError(message)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-6">
            <p>Loading order details...</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (error && !order) {
    return (
      <div className="container mx-auto p-6">
        <Alert>
          <AlertDescription className="text-red-600">{error}</AlertDescription>
        </Alert>
      </div>
    )
  }

  if (!order) {
    return null
  }

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <h1 className="text-3xl font-bold mb-6">Provide Quote</h1>

      {/* Order Details */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Order Details</CardTitle>
          <CardDescription>Review the client&apos;s request before providing a quote</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <span className="font-medium">Service:</span>
              <p className="text-gray-700">{order.service.name}</p>
              <span className="text-sm text-gray-500">{order.service.category}</span>
            </div>

            <div>
              <span className="font-medium">Client:</span>
              <p className="text-gray-700">{order.client.name}</p>
              <p className="text-sm text-gray-500">{order.client.email}</p>
            </div>

            <div>
              <span className="font-medium">Sample Description:</span>
              <p className="text-gray-700">{order.sampleDescription}</p>
            </div>

            {order.specialInstructions && (
              <div>
                <span className="font-medium">Special Instructions:</span>
                <p className="text-gray-700">{order.specialInstructions}</p>
              </div>
            )}

            <div>
              <span className="font-medium">Submitted:</span>
              <p className="text-sm text-gray-500">
                {new Date(order.createdAt).toLocaleDateString()}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Quote Form */}
      <Card>
        <CardHeader>
          <CardTitle>Your Quote</CardTitle>
          <CardDescription>Provide pricing and timeline for this service request</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <Alert>
                <AlertDescription className="text-red-600">{error}</AlertDescription>
              </Alert>
            )}

            {/* Quoted Price */}
            <div>
              <label htmlFor="quotedPrice" className="block font-medium mb-1">
                Quoted Price (PHP) <span className="text-red-500" aria-label="required">*</span>
              </label>
              <input
                type="number"
                id="quotedPrice"
                value={quotedPrice}
                onChange={(e) => setQuotedPrice(e.target.value)}
                step="0.01"
                min="0"
                required
                aria-required="true"
                aria-invalid={!!formErrors.quotedPrice}
                aria-describedby={formErrors.quotedPrice ? "quotedPrice-error" : undefined}
                className="w-full border rounded p-2 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500"
                placeholder="e.g., 1500.00"
              />
              {formErrors.quotedPrice && (
                <p id="quotedPrice-error" className="text-sm text-red-600 mt-1" role="alert">{formErrors.quotedPrice}</p>
              )}
            </div>

            {/* Turnaround Days */}
            <div>
              <label htmlFor="estimatedTurnaroundDays" className="block font-medium mb-1">
                Estimated Turnaround (days)
              </label>
              <input
                type="number"
                id="estimatedTurnaroundDays"
                value={estimatedTurnaroundDays}
                onChange={(e) => setEstimatedTurnaroundDays(e.target.value)}
                min="1"
                step="1"
                aria-invalid={!!formErrors.estimatedTurnaroundDays}
                aria-describedby={formErrors.estimatedTurnaroundDays ? "estimatedTurnaroundDays-error" : undefined}
                className="w-full border rounded p-2 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500"
                placeholder="e.g., 5"
              />
              {formErrors.estimatedTurnaroundDays && (
                <p id="estimatedTurnaroundDays-error" className="text-sm text-red-600 mt-1" role="alert">{formErrors.estimatedTurnaroundDays}</p>
              )}
            </div>

            {/* Quote Notes */}
            <div>
              <label htmlFor="quoteNotes" className="block font-medium mb-1">
                Quote Notes
              </label>
              <textarea
                id="quoteNotes"
                value={quoteNotes}
                onChange={(e) => setQuoteNotes(e.target.value)}
                rows={4}
                className="w-full border rounded p-2 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500"
                placeholder="Additional details, clarifications, or terms for this quote..."
              />
              <p className="text-sm text-gray-500 mt-1">
                Optional: Explain pricing breakdown, special conditions, or requirements
              </p>
            </div>

            {/* Actions */}
            <div className="flex gap-4 pt-4">
              <Button
                type="submit"
                disabled={submitting}
                className="bg-green-600 hover:bg-green-700 text-white"
              >
                {submitting ? 'Submitting...' : 'Submit Quote'}
              </Button>
              <Button
                type="button"
                onClick={() => router.back()}
                variant="outline"
                disabled={submitting}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
