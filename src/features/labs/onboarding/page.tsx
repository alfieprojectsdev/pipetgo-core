import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { OnboardingForm } from './ui'

export default async function LabOnboardingPage() {
  const session = await auth()
  if (!session?.user.id) redirect('/auth/signin')

  return (
    <main>
      <h1>Register your lab</h1>
      <OnboardingForm />
    </main>
  )
}
