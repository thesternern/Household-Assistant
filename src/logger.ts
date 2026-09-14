import pino from 'pino'

const level = process.env.LOG_LEVEL ?? 'info'
const pretty = process.env.NODE_ENV !== 'production'

/**
 * Backstop redaction. Every call site that logs an error from an HTTP client
 * already strips the request config, but a new `{ err }` somewhere is one
 * refactor away, and an axios-style error carries the Authorization header,
 * the client secret, and the OAuth code inside `config` and `response`.
 */
const redact = [
  'err.config',
  'err.response',
  '*.authorization',
  '*.Authorization',
  '*.cookie',
  '*.set-cookie',
  '*.client_secret',
  '*.refresh_token',
  '*.access_token',
  '*.secret_token',
  '*["x-telegram-bot-api-secret-token"]',
  '*["x-vapi-secret"]',
  '*["x-twilio-signature"]',
]

export const logger = pino(
  pretty
    ? {
        level,
        redact,
        transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
      }
    : { level, redact },
)

export function child(bindings: Record<string, unknown>) {
  return logger.child(bindings)
}
