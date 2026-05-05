import { config } from 'dotenv'
import path from 'path'
import { execSync } from 'child_process'

export default function setup() {
  config({ path: path.resolve(process.cwd(), '.env.test') })

  const testUrl = process.env.DATABASE_TEST_URL
  if (!testUrl) {
    throw new Error('DATABASE_TEST_URL must be set in .env.test')
  }

  execSync('npx prisma db push --skip-generate', {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'inherit',
  })
}
