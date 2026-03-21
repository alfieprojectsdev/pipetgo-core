'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'

interface BreadcrumbItem {
  label: string
  href: string
}

// Route-to-breadcrumb mapping
const breadcrumbMap: Record<string, BreadcrumbItem[]> = {
  // CLIENT routes
  '/dashboard/client': [{ label: 'Dashboard', href: '/dashboard/client' }],

  // LAB_ADMIN routes
  '/dashboard/lab': [{ label: 'Dashboard', href: '/dashboard/lab' }],
  '/dashboard/lab/services': [
    { label: 'Dashboard', href: '/dashboard/lab' },
    { label: 'Services', href: '/dashboard/lab/services' }
  ],
  '/dashboard/lab/analytics': [
    { label: 'Dashboard', href: '/dashboard/lab' },
    { label: 'Analytics', href: '/dashboard/lab/analytics' }
  ],

  // ADMIN routes
  '/dashboard/admin': [{ label: 'Dashboard', href: '/dashboard/admin' }],
}

// Generate breadcrumbs for dynamic routes (e.g., /dashboard/lab/orders/[id]/quote)
function generateDynamicBreadcrumbs(pathname: string): BreadcrumbItem[] | null {
  // Handle quote provision route: /dashboard/lab/orders/[id]/quote
  const quoteMatch = pathname.match(/^\/dashboard\/lab\/orders\/([^/]+)\/quote$/)
  if (quoteMatch) {
    const orderId = quoteMatch[1]
    return [
      { label: 'Dashboard', href: '/dashboard/lab' },
      { label: 'Orders', href: '/dashboard/lab' },
      { label: `Order ${orderId.substring(0, 8)}...`, href: '#' },
      { label: 'Provide Quote', href: pathname }
    ]
  }

  return null
}

export function Breadcrumbs() {
  const pathname = usePathname()

  // Get breadcrumbs from map or generate for dynamic routes
  let breadcrumbs = breadcrumbMap[pathname] || generateDynamicBreadcrumbs(pathname)

  // If no breadcrumbs found, return null (don't show breadcrumbs)
  if (!breadcrumbs || breadcrumbs.length <= 1) {
    return null
  }

  return (
    <nav aria-label="Breadcrumb" className="mb-4">
      <ol className="flex items-center gap-2 text-sm text-gray-600">
        {breadcrumbs.map((crumb, index) => {
          const isLast = index === breadcrumbs.length - 1

          return (
            <li key={crumb.href} className="flex items-center gap-2">
              {isLast ? (
                <span className="font-medium text-gray-900" aria-current="page">
                  {crumb.label}
                </span>
              ) : (
                <>
                  <Link
                    href={crumb.href}
                    className="hover:text-gray-900 hover:underline"
                  >
                    {crumb.label}
                  </Link>
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
