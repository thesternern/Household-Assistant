import { getConfig } from './config.js'
import { closeDb } from './db/client.js'
import { runMigrations } from './db/migrate.js'
import { QUEUES, registerJobHandler, startQueue, stopQueue } from './jobs/queue.js'
import { logger } from './logger.js'
import { seedPolicies } from './policy/engine.js'
import { startServer, stopServer } from './http/server.js'
import { registerWebhook, startLongPolling, stopLongPolling } from './telegram/bot.js'
import { shutdownBrowser } from './browser/worker.js'
import { runWatcherPollJob } from './watchers/index.js'

let shuttingDown = false

async function main(): Promise<void> {
  // Fail fast and loudly. A half-configured household assistant is worse than none.
  const cfg = getConfig()
  logger.info(
    { env: cfg.NODE_ENV, tz: cfg.HOUSEHOLD_TIMEZONE, dryRunCalls: cfg.DRY_RUN_CALLS },
    'home-assistant starting',
  )

  await runMigrations()
  await seedPolicies()

  // The HTTP server comes up before the queue so Railway's healthcheck can pass
  // while pg-boss is still creating its schema on a cold database.
  await startServer()

  // Subsystems claim their queues before the workers start. Without this the
  // watcher cron sees no handler and skips every poll, so the daycare pipeline
  // silently does nothing at all.
  registerJobHandler(QUEUES.watcherPoll, runWatcherPollJob)

  await startQueue()

  if (cfg.isProd) {
    await registerWebhook()
    logger.info('telegram webhook registered')
  } else {
    await startLongPolling()
    logger.info('telegram long polling started (no tunnel needed)')
  }

  logger.info('home-assistant ready')
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'shutting down')

  // Stop taking new work first, then drain, then close connections.
  const steps: Array<[string, () => Promise<unknown>]> = [
    ['long polling', stopLongPolling],
    ['queue', stopQueue],
    ['http', stopServer],
    ['browser', shutdownBrowser],
    ['db', closeDb],
  ]

  for (const [name, fn] of steps) {
    try {
      await fn()
    } catch (err) {
      logger.error({ err, step: name }, 'shutdown step failed')
    }
  }

  logger.info('shutdown complete')
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandled rejection')
})
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception — exiting so Railway restarts us clean')
  process.exit(1)
})

main().catch((err) => {
  logger.fatal({ err }, 'failed to start')
  process.exit(1)
})
