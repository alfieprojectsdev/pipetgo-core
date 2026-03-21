// src/app/layout.tsx
import type { Metadata } from 'next'
import localFont from 'next/font/local'
import Script from 'next/script'
import './globals.css'
import { AuthProvider } from '@/components/auth-provider'
import { GoatCounterTracker } from '@/components/analytics/goatcounter-tracker'
import { Toaster } from 'sonner'

const inter = localFont({
  src: [
    {
      path: '../../public/fonts/inter-400.woff2',
      weight: '400',
      style: 'normal',
    },
    {
      path: '../../public/fonts/inter-600.woff2',
      weight: '600',
      style: 'normal',
    },
  ],
  variable: '--font-inter',
  display: 'swap',
})

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'PipetGo! - Lab Services Marketplace',
  description: 'Connect with accredited laboratories for testing services',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <AuthProvider>
          {children}
        </AuthProvider>
        <Toaster position="top-right" />

        {/* GoatCounter Analytics - Level 1 (Page Views Only) */}
        {process.env.NEXT_PUBLIC_GOATCOUNTER_URL && (
          <>
            <GoatCounterTracker />
            <Script
              data-goatcounter={process.env.NEXT_PUBLIC_GOATCOUNTER_URL}
              async
              src="//gc.zgo.at/count.js"
              strategy="afterInteractive"
            />
          </>
        )}
      </body>
    </html>
  )
}
