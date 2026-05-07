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

declare module '@auth/core/jwt' {
  interface JWT {
    role?: UserRole
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [Google({})],
  session: { strategy: 'jwt' },
  trustHost: process.env.AUTH_TRUST_HOST === 'true',
  pages: {
    signIn: '/auth/signin',
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = user.role ?? UserRole.CLIENT
      } else if (token.sub) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.sub },
          select: { role: true },
        })
        if (dbUser) token.role = dbUser.role
      }
      return token
    },
    session({ session, token }) {
      if (!token.role) {
        throw new Error('JWT token missing role — auth misconfiguration')
      }
      if (!token.sub) {
        throw new Error('JWT token missing sub — auth misconfiguration')
      }
      return {
        ...session,
        user: {
          ...session.user,
          id: token.sub,
          role: token.role,
        },
      }
    },
  },
})
