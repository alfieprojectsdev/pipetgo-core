import { config } from 'dotenv'
import path from 'path'

config({ path: path.resolve(process.cwd(), '.env.test') })

if (!process.env.DATABASE_TEST_URL) {
  throw new Error(
    'DATABASE_TEST_URL must be set in .env.test — ' +
      'refusing to run tests without it to prevent production DB usage',
  )
}
