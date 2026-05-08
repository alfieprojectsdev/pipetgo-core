'use server'

import { redirect } from 'next/navigation'
import { z } from 'zod'
import { UserRole } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'

const onboardingSchema = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(500).optional(),
  city: z.string().min(1).max(100),
  country: z.string().min(1).max(100),
})

export type OnboardingState = {
  errors?: Partial<Record<keyof z.infer<typeof onboardingSchema>, string[]>>
  message?: string
}

export async function registerLab(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const session = await auth()
  if (!session?.user.id) redirect('/auth/signin')

  const parsed = onboardingSchema.safeParse({
    name: formData.get('name'),
    description: formData.get('description') || undefined,
    city: formData.get('city'),
    country: formData.get('country'),
  })

  if (!parsed.success) {
    return { errors: parsed.error.flatten().fieldErrors }
  }

  const existing = await prisma.lab.findFirst({
    where: { ownerId: session.user.id },
  })
  if (existing) {
    return { message: 'Lab already registered for this account.' }
  }

  const { name, description, city, country } = parsed.data

  await prisma.$transaction([
    prisma.lab.create({
      data: {
        ownerId: session.user.id,
        name,
        description,
        location: { city, country },
        certifications: [],
      },
    }),
    prisma.user.update({
      where: { id: session.user.id },
      data: { role: UserRole.LAB_ADMIN },
    }),
  ])

  redirect('/dashboard/lab')
}
