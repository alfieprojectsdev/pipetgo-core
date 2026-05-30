/**
 * Route-group layout guard for /dashboard/admin/*.
 * Redirects non-ADMIN sessions before rendering any child page.
 * This is layer 1 of the two-layer admin auth pattern. Layer 2 is the independent
 * role===ADMIN re-check inside each Server Action — the layout guard does not protect
 * Server Actions because they are independently POST-invocable (TOCTOU). (ref: DL-001)
 */
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
    redirect('/auth/signin')
  }

  return <>{children}</>
}
