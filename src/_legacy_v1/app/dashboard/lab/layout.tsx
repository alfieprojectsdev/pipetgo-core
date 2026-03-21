import { Toaster } from 'sonner'

export default function LabLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <Toaster position="top-right" />
    </>
  )
}
