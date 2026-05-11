import { prisma } from '@/lib/prisma'
import { ServiceCategory, PricingMode } from '@prisma/client'
import { ServiceBrowseUI } from './ui'

export type ServiceBrowseDTO = {
  id: string
  name: string
  description: string | null
  category: ServiceCategory
  pricingMode: PricingMode
  pricePerUnit: string | null  // Decimal.toFixed(2) or null — NEVER Prisma.Decimal
  unit: string | null
  lab: {
    name: string
    location: Record<string, unknown> | null  // Json? — city/province/country keys
  }
}

export default async function ServiceBrowsePage({
  searchParams,
}: {
  searchParams: { category?: string }
}) {
  const validCategories = Object.values(ServiceCategory) as string[]
  const activeCategory = validCategories.includes(searchParams.category ?? '')
    ? (searchParams.category as ServiceCategory)
    : null

  const services = await prisma.labService.findMany({
    where: {
      isActive: true,
      ...(activeCategory ? { category: activeCategory } : {}),
    },
    include: { lab: { select: { name: true, location: true } } },
    orderBy: { name: 'asc' },
  })

  const dtos: ServiceBrowseDTO[] = services.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    category: s.category,
    pricingMode: s.pricingMode,
    pricePerUnit: s.pricePerUnit?.toFixed(2) ?? null,
    unit: s.unit,
    lab: {
      name: s.lab.name,
      location: s.lab.location as Record<string, unknown> | null,
    },
  }))

  return <ServiceBrowseUI services={dtos} activeCategory={activeCategory} />
}
