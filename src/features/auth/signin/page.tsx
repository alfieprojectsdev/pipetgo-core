import { signIn } from '@/lib/auth'

export default function SignInPage() {
  return (
    <main>
      <h1>Sign in to PipetGo</h1>
      <form
        action={async () => {
          'use server'
          await signIn('google', { redirectTo: '/dashboard/client' })
        }}
      >
        <button type="submit">Sign in with Google</button>
      </form>
    </main>
  )
}
