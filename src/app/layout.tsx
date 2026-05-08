import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'PipetGo',
  description: 'Lab testing marketplace',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
