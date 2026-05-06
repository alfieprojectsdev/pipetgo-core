import NextAuth, { type DefaultSession } from 'next-auth'
import Google from 'next-auth/providers/google'
import { PrismaAdapter } from '@auth/prisma-adapter'
import { UserRole } from '@prisma/client'
import { prisma } from '@/lib/prisma'

declare module 'next-auth' {
  interface Session {
    user: {
      id: string
      role: UserRole
    } & DefaultSession['user']
  }
  interface User {
    role?: UserRole
  }
}

declare module '@auth/core/adapters' {
  interface AdapterUser {
    role: UserRole
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [Google({})],
  session: { strategy: 'jwt' },
  trustHost: true,
  pages: {
    signIn: '/auth/signin',
  },
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.role = user.role ?? UserRole.CLIENT
      }
      return token
    },
    session({ session, token }) {
      if (!token.role) {
        throw new Error('JWT token missing role — auth misconfiguration')
      }
      return {
        ...session,
        user: {
          ...session.user,
          id: token.sub ?? '',
          role: token.role as UserRole,
        },
      }
    },
  },
})
