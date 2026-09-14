import { z } from 'zod'

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v.toLowerCase() === 'true' || v === '1'))

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number())

const csv = (def: string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? def
        : v
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean),
    )

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: num(3000),
  LOG_LEVEL: z.string().default('info'),

  // Core
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  APP_URL: z.string().min(1, 'APP_URL is required (public https base URL)'),
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 chars (used for encryption)'),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(8, 'TELEGRAM_WEBHOOK_SECRET is required'),
  TELEGRAM_USER_ID_1: z.string().min(1, 'TELEGRAM_USER_ID_1 is required'),
  TELEGRAM_USER_ID_2: z.string().optional().default(''),

  // Models
  DEFAULT_MODEL: z.string().default('claude-sonnet-5'),
  EXTRACTION_MODEL: z.string().default('claude-haiku-4-5'),
  /** Tidies the grocery list: merges near-duplicates, rewrites quantities. Judgment, so not Haiku. */
  GROCERY_MODEL: z.string().default('claude-opus-5'),
  CLAUDE_CONFIG_DIR: z.string().default('/data/claude'),

  // Household
  HOUSEHOLD_TIMEZONE: z.string().default('America/Los_Angeles'),
  WEATHER_LATITUDE: z.string().optional().default(''),
  WEATHER_LONGITUDE: z.string().optional().default(''),

  // Google
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),

  // Vapi
  VAPI_API_KEY: z.string().optional().default(''),
  VAPI_PHONE_NUMBER_ID: z.string().optional().default(''),
  VAPI_WEBHOOK_SECRET: z.string().optional().default(''),
  DRY_RUN_CALLS: bool(true),

  // Twilio (SMS)
  TWILIO_ACCOUNT_SID: z.string().optional().default(''),
  TWILIO_AUTH_TOKEN: z.string().optional().default(''),
  TWILIO_FROM_NUMBER: z.string().optional().default(''),
  DRY_RUN_SMS: bool(true),

  // Browser / M5
  BROWSER_ENABLED: bool(false),
  BROWSER_ALLOWED_DOMAINS: csv(['amazon.com', 'www.amazon.com', 'smile.amazon.com']),
  BROWSER_PROFILE_DIR: z.string().default('/data/browser-profile'),
  DRY_RUN_BROWSER: bool(true),
  PURCHASE_MONTHLY_CAP: num(200),

  // Ops
  DAILY_BUDGET_ALERT_USD: num(5),
  AUDIT_RETENTION_DAYS: num(90),
  GITHUB_TOKEN: z.string().optional().default(''),
  GITHUB_REPO: z.string().default('your-user/your-repo'),
})

export type Config = z.infer<typeof schema> & {
  telegramUserIds: string[]
  isProd: boolean
  googleConfigured: boolean
  vapiConfigured: boolean
  twilioConfigured: boolean
  weatherConfigured: boolean
}

/**
 * Whether these three values could really reach Twilio.
 *
 * Shape, not presence. The Railway slots are seeded `REPLACE_ME` so they exist
 * before the household fills them, and a placeholder that reads as configured
 * turns a clean refusal at the gate into a puzzling failure at the Twilio API.
 * An account SID is always `AC` followed by 32 hex characters; an auth token is
 * 32 characters; a from-number is E.164.
 */
export function isTwilioConfigured(c: {
  TWILIO_ACCOUNT_SID: string
  TWILIO_AUTH_TOKEN: string
  TWILIO_FROM_NUMBER: string
}): boolean {
  return (
    /^AC[0-9a-f]{32}$/i.test(c.TWILIO_ACCOUNT_SID.trim()) &&
    c.TWILIO_AUTH_TOKEN.trim().length >= 32 &&
    /^\+[1-9]\d{7,14}$/.test(c.TWILIO_FROM_NUMBER.trim())
  )
}

function load(): Config {
  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    // Fail fast and loudly: a half-configured household assistant is worse than none.
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  const c = parsed.data
  const telegramUserIds = [c.TELEGRAM_USER_ID_1, c.TELEGRAM_USER_ID_2].filter(Boolean)
  return {
    ...c,
    telegramUserIds,
    isProd: c.NODE_ENV === 'production',
    googleConfigured: Boolean(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET),
    vapiConfigured: Boolean(c.VAPI_API_KEY && c.VAPI_PHONE_NUMBER_ID),
    twilioConfigured: isTwilioConfigured(c),
    weatherConfigured: Boolean(c.WEATHER_LATITUDE && c.WEATHER_LONGITUDE),
  }
}

let cached: Config | null = null
export function getConfig(): Config {
  if (!cached) cached = load()
  return cached
}

/** Test seam — lets vitest inject a config without touching process.env globally. */
export function __setConfigForTests(c: Config | null): void {
  cached = c
}
