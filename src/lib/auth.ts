import NextAuth, { type DefaultSession } from 'next-auth'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      role: string
    } & DefaultSession['user']
  }
  interface User {
    role?: string
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [],
  callbacks: {
    session({ session, token }) {
      return {
        ...session,
        user: {
          ...session.user,
          id: token.sub ?? '',
          role: (token as { role?: string }).role ?? 'CLIENT',
        },
      }
    },
    jwt({ token, user }) {
      if (user && 'role' in user) {
        token = { ...token, role: (user as { role: string }).role }
      }
      return token
    },
  },
})
