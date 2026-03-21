import { getServerSession } from 'next-auth'
import { redirect } from 'next/navigation'
import { authOptions } from '@/lib/auth'
import { DashboardNav } from './components/DashboardNav'
import { Breadcrumbs } from './components/Breadcrumbs'
import { ErrorBoundary } from '@/components/ErrorBoundary'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions)

  // Redirect to signin if not authenticated
  if (!session?.user) {
    redirect('/auth/signin')
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-gray-50">
        <DashboardNav role={session.user.role} />
        <main className="container mx-auto p-4 md:p-6 lg:p-8">
          <Breadcrumbs />
          {children}
        </main>
      </div>
    </ErrorBoundary>
  )
}
