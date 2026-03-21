'use client'

import { useSession } from 'next-auth/react'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { formatCurrency } from '@/lib/utils'
import { toast } from '@/lib/toast'

interface LabLocation {
  city?: string
  province?: string
  country?: string
}

interface LabService {
  id: string
  name: string
  description: string
  category: string
  pricingMode: 'QUOTE_REQUIRED' | 'FIXED' | 'HYBRID'
  pricePerUnit: number | null
  turnaroundDays: number
  sampleRequirements: string
  lab: {
    name: string
    location: LabLocation | null
    certifications: string[]
  }
}

interface OrderData {
  serviceId: string
  sampleDescription: string
  specialInstructions: string
  clientDetails: {
    contactEmail: string
    contactPhone: string
    organization: string
    shippingAddress: {
      street: string
      city: string
      postal: string
      country: string
    }
  }
  requestCustomQuote?: boolean
}

export default function OrderPage({ params }: { params: { serviceId: string } }) {
  const { data: session, status } = useSession()
  const router = useRouter()
  const [service, setService] = useState<LabService | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [requestCustomQuote, setRequestCustomQuote] = useState(false)
  const [formData, setFormData] = useState({
    sampleDescription: '',
    specialInstructions: '',
    contactEmail: '',
    contactPhone: '',
    organization: '',
    street: '',
    city: '',
    postal: '',
  })

  useEffect(() => {
    if (status === 'loading') return
    if (!session || session.user.role !== 'CLIENT') {
      router.push('/auth/signin')
      return
    }
    fetchService()
  }, [session, status, router, params.serviceId])

  const fetchService = async () => {
    try {
      const response = await fetch(`/api/services?serviceId=${params.serviceId}`)
      if (response.ok) {
        const data = await response.json()
        const foundService = data.items?.find((s: LabService) => s.id === params.serviceId)
        if (foundService) {
          setService(foundService)
          setFormData(prev => ({ ...prev, contactEmail: session?.user?.email || '' }))
        } else {
          router.push('/')
        }
      }
    } catch (error) {
      console.error('Error fetching service:', error)
      router.push('/')
    } finally {
      setIsLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSubmitting(true)

    try {
      const orderData: OrderData = {
        serviceId: params.serviceId,
        sampleDescription: formData.sampleDescription,
        specialInstructions: formData.specialInstructions,
        clientDetails: {
          contactEmail: formData.contactEmail,
          contactPhone: formData.contactPhone,
          organization: formData.organization,
          shippingAddress: {
            street: formData.street,
            city: formData.city,
            postal: formData.postal,
            country: 'Philippines'
          }
        },
        // Add requestCustomQuote for HYBRID services
        ...(service?.pricingMode === 'HYBRID' && { requestCustomQuote })
      }

      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderData)
      })

      if (response.ok) {
        toast.success('Order submitted successfully!', 'Redirecting to your dashboard')
        router.push('/dashboard/client')
      } else {
        const error = await response.json()
        toast.error('Failed to submit order', error.error)
      }
    } catch (error) {
      console.error('Error submitting order:', error)
      toast.error('An error occurred', 'Please try again')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (status === 'loading' || isLoading) {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>
  }

  if (!service) {
    return <div className="flex items-center justify-center min-h-screen">Service not found</div>
  }

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-6">
          <Button variant="outline" onClick={() => router.back()}>
            ← Back
          </Button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">
          {/* Service Details */}
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">{service.name}</CardTitle>
              <CardDescription>{service.lab.name}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <h4 className="font-medium text-gray-900">Description</h4>
                <p className="text-gray-700">{service.description}</p>
              </div>
              
              <div>
                <h4 className="font-medium text-gray-900">Sample Requirements</h4>
                <p className="text-gray-700">{service.sampleRequirements}</p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <h4 className="font-medium text-gray-900">Price</h4>
                  {service.pricingMode === 'QUOTE_REQUIRED' ? (
                    <p className="text-sm text-gray-600">
                      <span className="text-green-600">ℹ️</span> Custom quote required
                    </p>
                  ) : service.pricingMode === 'FIXED' ? (
                    <p className="text-lg font-semibold text-green-600">
                      {formatCurrency(service.pricePerUnit!)} per sample
                    </p>
                  ) : (
                    <p className="text-sm text-gray-700">
                      From <span className="font-bold">{formatCurrency(service.pricePerUnit!)}</span>
                    </p>
                  )}
                </div>
                <div>
                  <h4 className="font-medium text-gray-900">Turnaround</h4>
                  <p className="text-lg font-semibold">{service.turnaroundDays} days</p>
                </div>
              </div>

              <div>
                <h4 className="font-medium text-gray-900">Lab Location</h4>
                <p className="text-gray-700">{service.lab.location?.city || 'Metro Manila'}</p>
              </div>

              <div>
                <h4 className="font-medium text-gray-900">Certifications</h4>
                <div className="flex flex-wrap gap-2 mt-1">
                  {service.lab.certifications.map((cert) => (
                    <span key={cert} className="px-2 py-1 bg-green-100 text-green-800 rounded text-sm">
                      {cert}
                    </span>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Order Form */}
          <Card>
            <CardHeader>
              <CardTitle>Submit Test Request</CardTitle>
              <CardDescription>Provide details about your sample and shipping information</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="sampleDescription" className="block text-sm font-medium mb-1">
                    Sample Description *
                    <span className="text-sm text-gray-500 ml-2 font-normal">
                      ({formData.sampleDescription.length}/10 characters)
                    </span>
                  </label>
                  <textarea
                    id="sampleDescription"
                    value={formData.sampleDescription}
                    onChange={(e) => setFormData(prev => ({ ...prev, sampleDescription: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                    rows={3}
                    placeholder="Describe your sample (e.g., Coconut oil from batch #123, suspected contamination)"
                    minLength={10}
                    required
                  />
                  {formData.sampleDescription.length > 0 && formData.sampleDescription.length < 10 && (
                    <p className="text-sm text-red-600 mt-1">
                      Sample description must be at least 10 characters
                    </p>
                  )}
                </div>

                <div>
                  <label htmlFor="specialInstructions" className="block text-sm font-medium mb-1">
                    Special Instructions
                  </label>
                  <textarea
                    id="specialInstructions"
                    value={formData.specialInstructions}
                    onChange={(e) => setFormData(prev => ({ ...prev, specialInstructions: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                    rows={2}
                    placeholder="Any special handling requirements or notes"
                  />
                </div>

                {/* Pricing Mode Alerts */}
                {service.pricingMode === 'QUOTE_REQUIRED' && (
                  <Alert>
                    <AlertDescription>
                      <span className="text-green-600 font-medium">ℹ️ Custom quote required</span>
                      <p className="text-sm mt-1">
                        You&apos;ll submit an RFQ and receive a custom quote from the lab within 24-48 hours.
                      </p>
                    </AlertDescription>
                  </Alert>
                )}

                {service.pricingMode === 'HYBRID' && (
                  <div className="space-y-3">
                    <div className="flex items-start space-x-2">
                      <input
                        type="checkbox"
                        id="requestCustomQuote"
                        checked={requestCustomQuote}
                        onChange={(e) => setRequestCustomQuote(e.target.checked)}
                        className="mt-1"
                      />
                      <label htmlFor="requestCustomQuote" className="text-sm cursor-pointer">
                        Request custom quote instead of reference price ({service.pricePerUnit ? formatCurrency(service.pricePerUnit) : 'N/A'})
                      </label>
                    </div>

                    {requestCustomQuote ? (
                      <Alert>
                        <AlertDescription>
                          <span className="text-green-600 font-medium">ℹ️ Custom quote</span>
                          <p className="text-sm mt-1">
                            You&apos;ll submit an RFQ and receive a custom quote from the lab.
                          </p>
                        </AlertDescription>
                      </Alert>
                    ) : (
                      <Alert>
                        <AlertDescription>
                          <span className="text-green-600 font-medium">✓ Instant booking</span>
                          <p className="text-sm mt-1">
                            You&apos;ll book at the reference price: {service.pricePerUnit ? formatCurrency(service.pricePerUnit) : 'N/A'}
                          </p>
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                )}

                {service.pricingMode === 'FIXED' && (
                  <Alert>
                    <AlertDescription>
                      <span className="text-green-600 font-medium">✓ Fixed rate service</span>
                      <p className="text-sm mt-1">
                        Instant booking at {service.pricePerUnit ? formatCurrency(service.pricePerUnit) : 'N/A'} per sample.
                      </p>
                    </AlertDescription>
                  </Alert>
                )}

                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="contactEmail" className="block text-sm font-medium mb-1">
                      Contact Email *
                    </label>
                    <input
                      id="contactEmail"
                      type="email"
                      value={formData.contactEmail}
                      onChange={(e) => setFormData(prev => ({ ...prev, contactEmail: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                      required
                    />
                  </div>
                  <div>
                    <label htmlFor="contactPhone" className="block text-sm font-medium mb-1">
                      Contact Phone
                    </label>
                    <input
                      id="contactPhone"
                      type="tel"
                      value={formData.contactPhone}
                      onChange={(e) => setFormData(prev => ({ ...prev, contactPhone: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                      placeholder="+63917123456"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="organization" className="block text-sm font-medium mb-1">
                    Organization
                  </label>
                  <input
                    id="organization"
                    type="text"
                    value={formData.organization}
                    onChange={(e) => setFormData(prev => ({ ...prev, organization: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="Company or institution name"
                  />
                </div>

                <div>
                  <h4 className="font-medium mb-2">Shipping Address</h4>
                  <div className="space-y-2">
                    <div>
                      <label htmlFor="street" className="block text-sm font-medium mb-1">
                        Street Address *
                      </label>
                      <input
                        id="street"
                        type="text"
                        value={formData.street}
                        onChange={(e) => setFormData(prev => ({ ...prev, street: e.target.value }))}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                        placeholder="Street address"
                        required
                      />
                    </div>
                    <div className="grid sm:grid-cols-2 gap-2">
                      <div>
                        <label htmlFor="city" className="block text-sm font-medium mb-1">
                          City *
                        </label>
                        <input
                          id="city"
                          type="text"
                          value={formData.city}
                          onChange={(e) => setFormData(prev => ({ ...prev, city: e.target.value }))}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                          placeholder="City"
                          required
                        />
                      </div>
                      <div>
                        <label htmlFor="postal" className="block text-sm font-medium mb-1">
                          Postal Code *
                        </label>
                        <input
                          id="postal"
                          type="text"
                          value={formData.postal}
                          onChange={(e) => setFormData(prev => ({ ...prev, postal: e.target.value }))}
                          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                          placeholder="Postal code"
                          required
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="pt-4">
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={isSubmitting || formData.sampleDescription.length < 10}
                  >
                    {isSubmitting ? 'Submitting...' :
                      service.pricingMode === 'QUOTE_REQUIRED' ? 'Submit RFQ' :
                      service.pricingMode === 'HYBRID' && requestCustomQuote ? 'Submit RFQ' :
                      service.pricingMode === 'HYBRID' ? `Book Service - ${service.pricePerUnit ? formatCurrency(service.pricePerUnit) : ''}` :
                      `Book Service - ${service.pricePerUnit ? formatCurrency(service.pricePerUnit) : ''}`
                    }
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}