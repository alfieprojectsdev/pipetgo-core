import { PrismaClient } from '@prisma/client'

export const testPrisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_TEST_URL } },
})
