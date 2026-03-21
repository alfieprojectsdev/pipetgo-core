'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect } from 'react'

/**
 * GoatCounter Analytics Tracker for Next.js App Router
 *
 * Tracks client-side navigation (SPA routing) by listening to pathname changes.
 * The initial page load is tracked by the GoatCounter script in layout.tsx.
 *
 * Level 1 Analytics: Page views only (no custom events)
 *
 * @see docs/ADR_GOATCOUNTER_LEVEL1_ANALYTICS.md
 */
export function GoatCounterTracker() {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  useEffect(() => {
    // Only track if GoatCounter is loaded and we have a pathname
    if (typeof window !== 'undefined' && window.goatcounter && pathname) {
      const url = pathname + (searchParams.toString() ? `?${searchParams.toString()}` : '')

      // Track the page view
      window.goatcounter.count({
        path: url,
      })
    }
  }, [pathname, searchParams])

  // This component renders nothing - it only tracks navigation
  return null
}

// TypeScript declaration for window.goatcounter
declare global {
  interface Window {
    goatcounter?: {
      count: (vars: { path: string; title?: string; event?: boolean }) => void
    }
  }
}
