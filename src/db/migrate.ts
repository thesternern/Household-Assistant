import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { getDb, closeDb } from './client.js'
import { logger } from '../logger.js'

export async function runMigrations(): Promise<void> {
  logger.info('running database migrations')
  await migrate(getDb(), { migrationsFolder: './drizzle' })
  logger.info('migrations complete')
}

const isMain = process.argv[1]?.endsWith('migrate.ts') || process.argv[1]?.endsWith('migrate.js')
if (isMain) {
  runMigrations()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'migration failed')
      process.exit(1)
    })
}
