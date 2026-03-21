/**
 * 🔒 SECURITY: Set Password API Endpoint (P0-1 Password Authentication)
 * =======================================================================
 * Allows authenticated users with null hashedPassword to set a password.
 * Part of the migration strategy for OAuth-only users to password authentication.
 *
 * Security:
 * - User MUST be authenticated (check session)
 * - Rate limiting: 5 attempts per hour per user ID
 * - Password validated with Zod schema (client + server)
 * - Password hashed with bcrypt (12 salt rounds)
 * - Prevents overwriting existing passwords (409 Conflict)
 *
 * Flow:
 * 1. Check authentication (401 if not logged in)
 * 2. Rate limiting check (429 if exceeded)
 * 3. Validate password with passwordSchema
 * 4. Check if user already has hashedPassword (409 if yes)
 * 5. Hash password and update user
 * 6. Return success
 */

import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { hashPassword } from '@/lib/password'
import { passwordSchema } from '@/lib/validations/auth'
import {
  setPasswordRateLimiter,
  checkRateLimit,
  createRateLimitResponse
} from '@/lib/rate-limit'

export async function POST(req: NextRequest) {
  try {
    // 1. Check authentication
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // 2. Rate limiting (per user ID)
    const rateLimit = await checkRateLimit(setPasswordRateLimiter, session.user.id)

    if (rateLimit && !rateLimit.success) {
      return createRateLimitResponse(rateLimit.retryAfter!)
    }

    // 3. Parse and validate request
    const body = await req.json()
    const { password } = body

    if (!password) {
      return Response.json({ error: 'Password is required' }, { status: 400 })
    }

    // Validate password with Zod schema
    const validation = passwordSchema.safeParse(password)
    if (!validation.success) {
      return Response.json({
        error: 'Invalid password',
        details: validation.error.errors
      }, { status: 400 })
    }

    // 4. Check if user already has a password
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, hashedPassword: true }
    })

    if (!user) {
      return Response.json({ error: 'User not found' }, { status: 404 })
    }

    if (user.hashedPassword) {
      return Response.json({
        error: 'Password already set. Use password reset instead.'
      }, { status: 409 })
    }

    // 5. Hash password and update user
    const hashedPassword = await hashPassword(password)

    await prisma.user.update({
      where: { id: session.user.id },
      data: { hashedPassword: hashedPassword }
    })

    return Response.json({
      success: true,
      message: 'Password set successfully'
    })

  } catch (error) {
    console.error('Set password error:', error)
    return Response.json({
      error: 'Internal server error'
    }, { status: 500 })
  }
}
