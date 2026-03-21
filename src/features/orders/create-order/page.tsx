import { notFound, redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { OrderFormShell } from './ui'

export type CreateOrderServiceDTO = {
  id: string
  name: string
  description: string | null
  category: string                        // ServiceCategory enum value (string is safe to pass)
  pricingMode: 'QUOTE_REQUIRED' | 'FIXED' | 'HYBRID'
  pricePerUnit: string | null             // Decimal.toFixed(2) or null — NEVER Prisma.Decimal
  unit: string | null
  lab: {
    name: string
    location: Record<string, unknown> | null  // Json? field — city, province, country keys
    certifications: string[]
  }
}

export default async function CreateOrderPage({
  params,
}: {
  params: { serviceId: string }
}) {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
    redirect('/auth/signin')
  }

  const service = await prisma.labService.findUnique({
    where: { id: params.serviceId, isActive: true },
    include: { lab: { select: { name: true, location: true, certifications: true } } },
  })
  if (!service) notFound()

  const dto: CreateOrderServiceDTO = {
    id: service.id,
    name: service.name,
    description: service.description,
    category: service.category,
    pricingMode: service.pricingMode,
    pricePerUnit: service.pricePerUnit?.toFixed(2) ?? null,  // Decimal → string
    unit: service.unit,
    lab: {
      name: service.lab.name,
      location: service.lab.location as Record<string, unknown> | null,
      certifications: service.lab.certifications,
    },
  }

  const userEmail = session.user.email ?? ''

  return <OrderFormShell service={dto} userEmail={userEmail} />
}
