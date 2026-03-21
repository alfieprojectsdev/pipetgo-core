/**
 * NextAuth API Route
 *
 * TEMPORARY: Simplified handler without rate limiting due to NextAuth v4 incompatibility
 * with Next.js 14 App Router custom POST wrappers.
 *
 * TODO: Either:
 *   1. Migrate to NextAuth v5 (Auth.js) which has native App Router support
 *   2. Implement rate limiting in middleware.ts instead
 *
 * See: NEXTAUTH_V4_INCOMPATIBILITY.md for details
 */

import NextAuth from 'next-auth'
import { authOptions } from '@/lib/auth'

const handler = NextAuth(authOptions)

export { handler as GET, handler as POST }
