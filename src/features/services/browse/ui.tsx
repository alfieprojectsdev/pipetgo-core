'use client'

import { ServiceCategory, PricingMode } from '@prisma/client'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ServiceBrowseDTO } from './page'

const categoryLabels: Record<ServiceCategory, string> = {
  [ServiceCategory.CHEMICAL_TESTING]: 'Chemical Testing',
  [ServiceCategory.BIOLOGICAL_TESTING]: 'Biological Testing',
  [ServiceCategory.PHYSICAL_TESTING]: 'Physical Testing',
  [ServiceCategory.ENVIRONMENTAL_TESTING]: 'Environmental Testing',
  [ServiceCategory.CALIBRATION]: 'Calibration',
  [ServiceCategory.CERTIFICATION]: 'Certification',
}

const categoryBadgeClass: Record<ServiceCategory, string> = {
  [ServiceCategory.CHEMICAL_TESTING]: 'bg-purple-100 text-purple-800',
  [ServiceCategory.BIOLOGICAL_TESTING]: 'bg-green-100 text-green-800',
  [ServiceCategory.PHYSICAL_TESTING]: 'bg-blue-100 text-blue-800',
  [ServiceCategory.ENVIRONMENTAL_TESTING]: 'bg-teal-100 text-teal-800',
  [ServiceCategory.CALIBRATION]: 'bg-orange-100 text-orange-800',
  [ServiceCategory.CERTIFICATION]: 'bg-yellow-100 text-yellow-800',
}

function formatPrice(service: ServiceBrowseDTO): string {
  if (service.pricingMode === PricingMode.QUOTE_REQUIRED) return 'Quote required'
  if (!service.pricePerUnit) return 'Quote required'
  const price = `₱${parseFloat(service.pricePerUnit).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`
  const unitSuffix = service.unit ? `/${service.unit}` : ''
  if (service.pricingMode === PricingMode.HYBRID) return `${price}${unitSuffix} or custom quote`
  if (service.pricingMode === PricingMode.FIXED) return `${price}${unitSuffix}`
  throw new Error(`Unhandled PricingMode: ${service.pricingMode}`)
}

type Props = {
  services: ServiceBrowseDTO[]
  activeCategory: ServiceCategory | null
}

export function ServiceBrowseUI({ services, activeCategory }: Props) {
  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Lab Services</h1>
          <p className="mt-1 text-sm text-gray-500">
            Browse accredited laboratory services and submit a test request.
          </p>
        </div>

        {/* Category filter */}
        <div className="mb-6 flex flex-wrap gap-2">
          <a
            href="/services"
            className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium border transition-colors ${
              activeCategory === null
                ? 'bg-gray-900 text-white border-gray-900'
                : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400'
            }`}
          >
            All
          </a>
          {Object.values(ServiceCategory).map((cat) => (
            <a
              key={cat}
              href={`/services?category=${cat}`}
              className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium border transition-colors ${
                activeCategory === cat
                  ? 'bg-gray-900 text-white border-gray-900'
                  : 'bg-white text-gray-700 border-gray-300 hover:border-gray-400'
              }`}
            >
              {categoryLabels[cat]}
            </a>
          ))}
        </div>

        {services.length === 0 ? (
          <Card>
            <CardContent>
              <p className="py-8 text-center text-sm text-gray-500">
                No services available{activeCategory ? ` in ${categoryLabels[activeCategory]}` : ''}.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {services.map((service) => {
              // ?? fallback: deploy-safety against unknown enum values arriving before next deploy (ref: DL-003)
              const badgeClass = categoryBadgeClass[service.category] ?? 'bg-gray-100 text-gray-700'
              const categoryLabel = categoryLabels[service.category] ?? service.category
              return (
                <Card key={service.id} className="flex flex-col">
                  <CardHeader className="pb-2">
                    <div className="mb-1">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${badgeClass}`}>
                        {categoryLabel}
                      </span>
                    </div>
                    <CardTitle className="text-base leading-snug">{service.name}</CardTitle>
                    <p className="text-sm text-gray-500">{service.lab.name}</p>
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col justify-between pt-0">
                    {service.description && (
                      <p className="mb-3 text-sm text-gray-600 line-clamp-2">{service.description}</p>
                    )}
                    <div className="mt-auto">
                      <p className="mb-3 text-sm font-medium text-gray-900">{formatPrice(service)}</p>
                      {/* T-05 must mount create-order at /orders/new reading searchParams.serviceId, not a path param */}
                      <a
                        href={`/orders/new?serviceId=${service.id}`}
                        className={cn(buttonVariants({ size: 'sm' }), 'w-full text-center')}
                      >
                        Order this service
                      </a>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
