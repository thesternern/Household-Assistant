import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { getConfig } from '../config.js'
import * as schema from './schema.js'

let pool: pg.Pool | null = null
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null

export function getPool(): pg.Pool {
  if (!pool) {
    const { DATABASE_URL, isProd } = getConfig()
    pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 10,
      // Railway Postgres terminates TLS with a self-signed chain.
      ssl: isProd && !DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : undefined,
    })
  }
  return pool
}

export function getDb() {
  if (!dbInstance) dbInstance = drizzle(getPool(), { schema })
  return dbInstance
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
    dbInstance = null
  }
}

export { schema }
