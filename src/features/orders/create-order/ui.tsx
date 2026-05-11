'use client'

import { useActionState, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { HybridToggle } from './HybridToggle'
import { createOrder } from './action'
import type { CreateOrderServiceDTO } from './page'

type OrderFormShellProps = {
  service: CreateOrderServiceDTO
  userEmail: string
}

export function OrderFormShell({ service, userEmail }: OrderFormShellProps) {
  const [state, formAction, isPending] = useActionState(createOrder, null)
  const [isCustomQuote, setIsCustomQuote] = useState(false)

  const submitLabel = isPending
    ? 'Submitting...'
    : service.pricingMode === 'QUOTE_REQUIRED'
      ? 'Submit RFQ'
      : service.pricingMode === 'HYBRID' && isCustomQuote
        ? 'Submit RFQ'
        : service.pricingMode === 'HYBRID'
          ? `Book Service — ₱${service.pricePerUnit ?? ''}`
          : `Book Service — ₱${service.pricePerUnit ?? ''}`

  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-6">
          <a href="/" className="text-sm text-gray-600 hover:text-gray-900">
            ← Back
          </a>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">
          {/* LEFT — Service Detail Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-xl">{service.name}</CardTitle>
              <CardDescription>{service.lab.name}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {service.description && (
                <div>
                  <h4 className="font-medium text-gray-900">Description</h4>
                  <p className="text-gray-700">{service.description}</p>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <h4 className="font-medium text-gray-900">Price</h4>
                  {service.pricingMode === 'QUOTE_REQUIRED' ? (
                    <p className="text-sm text-gray-600">
                      <span className="text-green-600">ℹ️</span> Custom quote required
                    </p>
                  ) : service.pricingMode === 'FIXED' ? (
                    <p className="text-lg font-semibold text-green-600">
                      ₱{service.pricePerUnit} per sample
                    </p>
                  ) : (
                    <p className="text-sm text-gray-700">
                      From{' '}
                      <span className="font-bold">
                        ₱{service.pricePerUnit ?? 'N/A'}
                      </span>
                    </p>
                  )}
                </div>
              </div>

              <div>
                <h4 className="font-medium text-gray-900">Lab Location</h4>
                <p className="text-gray-700">
                  {(service.lab.location as { city?: string })?.city ?? 'Metro Manila'}
                </p>
              </div>

              {service.lab.certifications.length > 0 && (
                <div>
                  <h4 className="font-medium text-gray-900">Accreditations</h4>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {service.lab.certifications.map((cert) => (
                      <span
                        key={cert}
                        className="px-2 py-1 bg-green-100 text-green-800 rounded text-sm"
                      >
                        {cert}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* RIGHT — Order Form Card */}
          <Card>
            <CardHeader>
              <CardTitle>Submit Test Request</CardTitle>
              <CardDescription>
                Provide details about your sample and contact information
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form action={formAction} className="space-y-4">
                <input type="hidden" name="serviceId" value={service.id} />

                {/* Full Name — new V2 field */}
                <div>
                  <label htmlFor="name" className="block text-sm font-medium mb-1">
                    Full Name *
                  </label>
                  <input
                    id="name"
                    name="name"
                    type="text"
                    required
                    minLength={2}
                    maxLength={100}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                  {state?.errors?.name && (
                    <p className="text-sm text-red-600 mt-1">{state.errors.name[0]}</p>
                  )}
                </div>

                {/* Sample Description */}
                <div>
                  <label htmlFor="sampleDescription" className="block text-sm font-medium mb-1">
                    Sample Description *
                  </label>
                  <textarea
                    id="sampleDescription"
                    name="sampleDescription"
                    rows={3}
                    minLength={10}
                    required
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="Describe your sample (e.g., Coconut oil from batch #123)"
                  />
                </div>

                {/* Special Instructions */}
                <div>
                  <label htmlFor="specialInstructions" className="block text-sm font-medium mb-1">
                    Special Instructions
                  </label>
                  <textarea
                    id="specialInstructions"
                    name="specialInstructions"
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="Any special handling requirements or notes"
                  />
                </div>

                {/* Pricing Mode Alerts */}
                {service.pricingMode === 'QUOTE_REQUIRED' && (
                  <Alert>
                    <AlertDescription>
                      <span className="text-green-600 font-medium">ℹ️ Custom quote required</span>
                      <p className="text-sm mt-1">
                        You&apos;ll submit an RFQ and receive a custom quote from the lab within
                        24–48 hours.
                      </p>
                    </AlertDescription>
                  </Alert>
                )}

                {service.pricingMode === 'FIXED' && (
                  <Alert>
                    <AlertDescription>
                      <span className="text-green-600 font-medium">✓ Fixed rate service</span>
                      <p className="text-sm mt-1">
                        Instant booking at ₱{service.pricePerUnit ?? 'N/A'} per sample.
                      </p>
                    </AlertDescription>
                  </Alert>
                )}

                {service.pricingMode === 'HYBRID' && (
                  <HybridToggle
                    pricePerUnit={service.pricePerUnit}
                    onToggle={setIsCustomQuote}
                  />
                )}

                {/* Contact grid */}
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="email" className="block text-sm font-medium mb-1">
                      Contact Email *
                    </label>
                    <input
                      id="email"
                      name="email"
                      type="email"
                      required
                      defaultValue={userEmail}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                    />
                    {state?.errors?.email && (
                      <p className="text-sm text-red-600 mt-1">{state.errors.email[0]}</p>
                    )}
                  </div>
                  <div>
                    <label htmlFor="phone" className="block text-sm font-medium mb-1">
                      Contact Phone *
                    </label>
                    <input
                      id="phone"
                      name="phone"
                      type="tel"
                      required
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                      placeholder="+63 917 123 4567"
                    />
                    {state?.errors?.phone && (
                      <p className="text-sm text-red-600 mt-1">{state.errors.phone[0]}</p>
                    )}
                  </div>
                </div>

                {/* Organization */}
                <div>
                  <label htmlFor="organization" className="block text-sm font-medium mb-1">
                    Organization
                  </label>
                  <input
                    id="organization"
                    name="organization"
                    type="text"
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="Company or institution name"
                  />
                </div>

                {/* Address — collapsed from 3 legacy fields to 1 textarea */}
                <div>
                  <label htmlFor="address" className="block text-sm font-medium mb-1">
                    Shipping Address
                  </label>
                  <textarea
                    id="address"
                    name="address"
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="Street, City, Postal Code (e.g., 123 Rizal Ave, Makati, 1200)"
                  />
                </div>

                {/* Global error message */}
                {state?.message && (
                  <Alert variant="destructive">
                    <AlertDescription>{state.message}</AlertDescription>
                  </Alert>
                )}

                <div className="pt-2">
                  <Button type="submit" className="w-full" disabled={isPending}>
                    {submitLabel}
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
