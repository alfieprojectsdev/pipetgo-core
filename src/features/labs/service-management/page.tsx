import { notFound, redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import { CreateServiceForm, EditServiceForm, ToggleActiveForm } from './ui'

export default async function ServiceManagementPage() {
  const session = await auth()
  if (!session?.user.id || session.user.role !== 'LAB_ADMIN') redirect('/auth/signin')

  const lab = await prisma.lab.findFirst({ where: { ownerId: session.user.id } })
  if (!lab) notFound()

  const services = await prisma.labService.findMany({
    where: { labId: lab.id },
    orderBy: { createdAt: 'asc' },
  })

  return (
    <main>
      <h1>Manage services</h1>

      <section>
        <h2>Add a service</h2>
        <CreateServiceForm />
      </section>

      <section>
        <h2>Your services</h2>
        {services.length === 0 && <p>No services yet.</p>}
        {services.map((s) => (
          <div key={s.id}>
            <h3>
              {s.name} {!s.isActive && '(inactive)'}
            </h3>
            <p>
              {s.category.replace(/_/g, ' ')} — {s.pricingMode.replace(/_/g, ' ')}
            </p>
            <EditServiceForm
              serviceId={s.id}
              defaults={{
                name: s.name,
                description: s.description ?? undefined,
                category: s.category,
                pricingMode: s.pricingMode,
                pricePerUnit: s.pricePerUnit?.toString() ?? undefined,
                unit: s.unit ?? undefined,
              }}
            />
            <ToggleActiveForm serviceId={s.id} isActive={s.isActive} />
          </div>
        ))}
      </section>
    </main>
  )
}
