'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { PricingMode, ServiceCategory, UserRole } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'

const serviceSchema = z
  .object({
    name: z.string().min(2).max(100),
    description: z.string().max(500).optional(),
    category: z.nativeEnum(ServiceCategory),
    pricingMode: z.nativeEnum(PricingMode),
    pricePerUnit: z.string().optional(),
    unit: z.string().max(50).optional(),
  })
  .superRefine((data, ctx) => {
    if (
      (data.pricingMode === PricingMode.FIXED ||
        data.pricingMode === PricingMode.HYBRID) &&
      (!data.pricePerUnit ||
        isNaN(parseFloat(data.pricePerUnit)) ||
        parseFloat(data.pricePerUnit) <= 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pricePerUnit'],
        message: 'Price must be greater than 0 for FIXED and HYBRID services.',
      })
    }
    if (
      data.pricingMode === PricingMode.QUOTE_REQUIRED &&
      data.pricePerUnit
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pricePerUnit'],
        message: 'Price must be empty for QUOTE_REQUIRED services.',
      })
    }
  })

export type ServiceFormState = {
  errors?: Record<string, string[]>
  message?: string
}

async function resolveOwnedLab(userId: string) {
  const labs = await prisma.lab.findMany({ where: { ownerId: userId } })
  return labs.length === 1 ? labs[0] : null
}

export async function createService(
  _prev: ServiceFormState,
  formData: FormData,
): Promise<ServiceFormState> {
  const session = await auth()
  if (!session?.user.id) redirect('/auth/signin')
  if (session.user.role !== UserRole.LAB_ADMIN) return { message: 'Forbidden.' }

  const parsed = serviceSchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') || undefined,
    category: formData.get('category'),
    pricingMode: formData.get('pricingMode'),
    pricePerUnit: formData.get('pricePerUnit') || undefined,
    unit: formData.get('unit') || undefined,
  })

  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }

  const lab = await resolveOwnedLab(session.user.id)
  if (!lab) return { message: 'No lab found for this account.' }

  const { name, description, category, pricingMode, pricePerUnit, unit } = parsed.data

  try {
    await prisma.labService.create({
      data: {
        labId: lab.id,
        name,
        description,
        category,
        pricingMode,
        pricePerUnit: pricePerUnit ?? null,
        unit: unit ?? null,
      },
    })
  } catch {
    return { message: 'Failed to create service. Please try again.' }
  }

  redirect('/dashboard/lab')
}

export async function updateService(
  _prev: ServiceFormState,
  formData: FormData,
): Promise<ServiceFormState> {
  const session = await auth()
  if (!session?.user.id) redirect('/auth/signin')
  if (session.user.role !== UserRole.LAB_ADMIN) return { message: 'Forbidden.' }

  const serviceId = formData.get('serviceId')
  if (typeof serviceId !== 'string' || !serviceId) {
    return { message: 'Invalid service ID.' }
  }

  const parsed = serviceSchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') || undefined,
    category: formData.get('category'),
    pricingMode: formData.get('pricingMode'),
    pricePerUnit: formData.get('pricePerUnit') || undefined,
    unit: formData.get('unit') || undefined,
  })

  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }

  const lab = await resolveOwnedLab(session.user.id)
  if (!lab) return { message: 'No lab found for this account.' }

  const service = await prisma.labService.findUnique({ where: { id: serviceId } })
  if (!service || service.labId !== lab.id) {
    return { message: 'Service not found or access denied.' }
  }

  const { name, description, category, pricingMode, pricePerUnit, unit } = parsed.data

  try {
    await prisma.labService.update({
      where: { id: serviceId },
      data: {
        name,
        description,
        category,
        pricingMode,
        pricePerUnit: pricePerUnit ?? null,
        unit: unit ?? null,
      },
    })
  } catch {
    return { message: 'Failed to update service. Please try again.' }
  }

  redirect('/dashboard/lab')
}

export async function toggleServiceActive(
  _prev: ServiceFormState,
  formData: FormData,
): Promise<ServiceFormState> {
  const session = await auth()
  if (!session?.user.id) redirect('/auth/signin')
  if (session.user.role !== UserRole.LAB_ADMIN) return { message: 'Forbidden.' }

  const serviceId = formData.get('serviceId')
  if (typeof serviceId !== 'string' || !serviceId) {
    return { message: 'Invalid service ID.' }
  }

  const lab = await resolveOwnedLab(session.user.id)
  if (!lab) return { message: 'No lab found for this account.' }

  const service = await prisma.labService.findUnique({ where: { id: serviceId } })
  if (!service || service.labId !== lab.id) {
    return { message: 'Service not found or access denied.' }
  }

  try {
    await prisma.labService.update({
      where: { id: serviceId },
      data: { isActive: !service.isActive },
    })
  } catch {
    return { message: 'Failed to update service. Please try again.' }
  }

  redirect('/dashboard/lab')
}
