/**
 * PipetGo - B2B Lab Testing Marketplace
 * Copyright (c) 2025 PIPETGO, Inc. All rights reserved.
 * 
 * This file and its contents are the proprietary intellectual property of PIPETGO, Inc.
 * Unauthorized use, reproduction, or distribution is strictly prohibited.
 */
'use client'

import { useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatCurrency, cn } from '@/lib/utils'

export const dynamic = 'force-dynamic'

/**
 * Fetches a URL with a configurable timeout using AbortController.
 *
 * @param url - The URL to fetch
 * @param timeout - Timeout in milliseconds (default: 15000ms)
 * @returns Promise<Response> or throws AbortError if timeout occurs
 *
 * Example:
 *   const res = await fetchWithTimeout('/api/services', 15000)
 *   // Throws AbortError if request takes longer than 15 seconds
 */
async function fetchWithTimeout(
  url: string,
  timeout: number = 15000
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(url, { signal: controller.signal })
    clearTimeout(timeoutId)
    return response
  } catch (error) {
    clearTimeout(timeoutId)
    throw error
  }
}

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
  pricePerUnit: number | null
  pricingMode: 'QUOTE_REQUIRED' | 'FIXED' | 'HYBRID'
  turnaroundDays: number
  lab: {
    name: string
    location: LabLocation | null
  }
}

interface PaginationMeta {
  page: number
  pageSize: number
  totalCount: number
  totalPages: number
  hasMore: boolean
}

function getPricingModeVariant(mode: string): 'info' | 'success' | 'default' {
  const variants = {
    'QUOTE_REQUIRED': 'info' as const,     // Blue
    'FIXED': 'success' as const,            // Green
    'HYBRID': 'default' as const            // Purple (will use default for now, updated in Task 5)
  }
  return variants[mode as keyof typeof variants] || 'default'
}

function getPricingModeLabel(mode: string): string {
  const labels = {
    'QUOTE_REQUIRED': 'Quote Required',
    'FIXED': 'Fixed Rate',
    'HYBRID': 'Flexible Pricing'
  }
  return labels[mode as keyof typeof labels] || mode
}

export default function Home() {
  const { data: session } = useSession()
  const router = useRouter()
  const [services, setServices] = useState<LabService[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pagination, setPagination] = useState<PaginationMeta>({
    page: 1,
    pageSize: 12,
    totalCount: 0,
    totalPages: 0,
    hasMore: false
  })

  useEffect(() => {
    fetchServices(1)
  }, [])

  const fetchServices = async (page: number) => {
    setIsLoading(true)
    setError(null)

    try {
      const response = await fetchWithTimeout(
        `/api/services?page=${page}&pageSize=12`,
        15000
      )

      if (response.ok) {
        const data = await response.json()
        setServices(data.items)
        setPagination(data.pagination)
      } else {
        setError('Failed to load services. Please refresh the page.')
        console.error(
          'API returned non-OK status:',
          response.status,
          response.statusText
        )
      }
    } catch (error) {
      // Check for timeout/abort errors (AbortError)
      const isAbortError =
        error instanceof Error && error.name === 'AbortError'
      const isDOMException =
        error instanceof DOMException && error.name === 'AbortError'

      if (isAbortError || isDOMException) {
        setError(
          'Service loading is taking longer than expected. Please try again.'
        )
      } else {
        setError('Failed to load services. Please refresh the page.')
      }
      console.error('Error fetching services:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handlePrevPage = () => {
    if (pagination.page > 1) {
      setError(null)
      fetchServices(pagination.page - 1)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  const handleNextPage = () => {
    if (pagination.hasMore) {
      setError(null)
      fetchServices(pagination.page + 1)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  const handleOrderService = (serviceId: string) => {
    if (!session) {
      // Redirect to NextAuth's built-in signin page
      router.push('/api/auth/signin')
      return
    }
    router.push(`/order/${serviceId}`)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex justify-between items-center">
            <h1 className="text-2xl font-bold text-gray-900">PipetGo!</h1>
            {session ? (
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => {
                  const dashboardPath = session.user.role === 'ADMIN'
                    ? '/dashboard/admin'
                    : session.user.role === 'LAB_ADMIN'
                    ? '/dashboard/lab'
                    : '/dashboard/client'
                  router.push(dashboardPath)
                }}>
                  My Dashboard
                </Button>
                <Button variant="outline" onClick={() => router.push('/api/auth/signout')}>
                  Sign Out
                </Button>
              </div>
            ) : (
              <Button onClick={() => router.push('/api/auth/signin')}>
                Sign In
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className={session ? "bg-green-600 text-white py-6 sm:py-8" : "bg-green-600 text-white py-10 sm:py-16"}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {session ? (
            // Authenticated: Simpler, task-focused header
            <div>
              <h2 className="text-2xl sm:text-3xl font-bold mb-2">
                Browse Lab Services
              </h2>
              <p className="text-green-100 text-sm sm:text-base">
                {session.user.role === 'CLIENT'
                  ? 'Request quotes from ISO 17025 certified laboratories'
                  : 'Explore available testing services'}
              </p>
            </div>
          ) : (
            // Unauthenticated: Marketing-focused hero
            <div className="text-center">
              <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold mb-4">
                Find the Right Lab for Your Testing Needs
              </h2>
              <p className="text-base sm:text-lg lg:text-xl mb-6 sm:mb-8">
                Connect with accredited laboratories for food safety, environmental, and chemical analysis
              </p>
              <Button
                size="lg"
                className="bg-white text-green-600 hover:bg-gray-100 min-h-[44px] w-full sm:w-auto"
                onClick={() => router.push('/api/auth/signin')}
              >
                Get Started
              </Button>
            </div>
          )}
        </div>
      </section>

      {/* Services Section */}
      <section className="py-16">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {session ? (
            // Authenticated: Show service count and context
            <div className="mb-8">
              <h3 className="text-3xl font-bold mb-2">
                {pagination.totalCount > 0 ? `${pagination.totalCount} Services Available` : 'Lab Services'}
              </h3>
              <p className="text-gray-600">
                {session.user.role === 'CLIENT'
                  ? 'Click "Request Quote" to start an RFQ with any lab below'
                  : 'Browse our catalog of laboratory testing services'}
              </p>
            </div>
          ) : (
            // Unauthenticated: Simple centered title
            <h3 className="text-3xl font-bold text-center mb-12">Available Lab Services</h3>
          )}

          {error && (
            <div className="mb-8 p-4 bg-red-50 border border-red-200 rounded-lg">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3">
                  <span className="text-red-600 text-xl mt-0.5">⚠️</span>
                  <div>
                    <p className="text-red-800 font-medium">Unable to Load Services</p>
                    <p className="text-red-700 text-sm mt-1">{error}</p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    setError(null)
                    fetchServices(pagination.page)
                  }}
                  className="ml-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-medium whitespace-nowrap"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {isLoading ? (
            <div className="text-center py-12">
              <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-green-600 border-r-transparent align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite]"></div>
              <p className="mt-4 text-gray-600">Loading services...</p>
            </div>
          ) : services.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-600 text-lg">No lab services available at the moment.</p>
              <p className="text-gray-500 mt-2">Please check back later.</p>
            </div>
          ) : (
            <>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                {services.map((service) => (
                  <Card key={service.id} className="h-full">
                    <CardHeader>
                      <div className="flex flex-col sm:flex-row justify-between items-start gap-2 mb-2">
                        <CardTitle className="text-lg">{service.name}</CardTitle>
                        <div className="flex flex-wrap gap-2">
                          <span className="text-xs sm:text-sm bg-green-100 text-green-800 px-2 py-1 rounded whitespace-nowrap">
                            {service.category}
                          </span>
                          <Badge variant={getPricingModeVariant(service.pricingMode)} className="whitespace-nowrap">
                            {getPricingModeLabel(service.pricingMode)}
                          </Badge>
                        </div>
                      </div>
                      <CardDescription className="text-sm text-gray-600">
                        {service.lab.name} • {service.lab.location?.city || 'Metro Manila'}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <p className="text-gray-700 mb-4 line-clamp-3">
                        {service.description}
                      </p>

                      {service.pricingMode === 'QUOTE_REQUIRED' && (
                        <div className="text-gray-600 mb-4">
                          <p className="flex items-center gap-2">
                            <span className="text-green-600">ℹ️</span>
                            Custom quote required
                          </p>
                          <p className="text-sm">Submit RFQ to get pricing</p>
                        </div>
                      )}

                      {service.pricingMode === 'FIXED' && (
                        <div className="mb-4">
                          <div className="flex flex-col sm:flex-row justify-between gap-1">
                            <span className="font-medium">Price:</span>
                            <span className="text-lg sm:text-xl font-bold text-green-600">
                              {formatCurrency(service.pricePerUnit!)} per sample
                            </span>
                          </div>
                        </div>
                      )}

                      {service.pricingMode === 'HYBRID' && service.pricePerUnit && (
                        <div className="text-gray-700 mb-4">
                          <p className="text-sm">
                            From <span className="font-bold">{formatCurrency(service.pricePerUnit)}</span> or request custom quote
                          </p>
                        </div>
                      )}

                      <div className="flex flex-col sm:flex-row justify-between gap-1 mb-4">
                        <span className="font-medium">Turnaround:</span>
                        <span>{service.turnaroundDays} days</span>
                      </div>

                      <Button
                        className={cn(
                          "w-full",
                          service.pricingMode === 'QUOTE_REQUIRED' && "bg-blue-600 hover:bg-blue-700",
                          service.pricingMode === 'FIXED' && "bg-green-600 hover:bg-green-700",
                          service.pricingMode === 'HYBRID' && "bg-purple-600 hover:bg-purple-700"
                        )}
                        onClick={() => handleOrderService(service.id)}
                      >
                        {session && session.user.role === 'CLIENT' ? (
                          // Authenticated CLIENT: Action-oriented
                          service.pricingMode === 'QUOTE_REQUIRED'
                            ? 'Request Quote →'
                            : service.pricingMode === 'HYBRID'
                            ? 'Get Quote →'
                            : 'Request Service →'
                        ) : (
                          // Unauthenticated or non-CLIENT: Standard
                          service.pricingMode === 'QUOTE_REQUIRED'
                            ? 'Request Quote'
                            : service.pricingMode === 'HYBRID'
                            ? 'View Options'
                            : 'Book Service'
                        )}
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Pagination Controls */}
              {pagination.totalPages > 1 && (
                <div className="mt-12 flex flex-col sm:flex-row justify-center items-center gap-4">
                  <Button
                    variant="outline"
                    onClick={handlePrevPage}
                    disabled={pagination.page === 1}
                    className="w-full sm:w-auto min-h-[44px]"
                  >
                    Previous
                  </Button>

                  <div className="flex flex-col sm:flex-row items-center gap-1 sm:gap-2 text-center">
                    <span className="text-gray-700">
                      Page {pagination.page} of {pagination.totalPages}
                    </span>
                    <span className="text-gray-500 text-sm">
                      ({pagination.totalCount} total services)
                    </span>
                  </div>

                  <Button
                    variant="outline"
                    onClick={handleNextPage}
                    disabled={!pagination.hasMore}
                    className="w-full sm:w-auto min-h-[44px]"
                  >
                    Next
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-900 text-white py-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <p>&copy; 2025 PipetGo! Lab Services Marketplace MVP.</p>
        </div>
      </footer>
    </div>
  )
}