/**
 * One line of weather for the morning brief.
 *
 * Open-Meteo needs no API key and no account, which is the whole reason it is
 * here: the household should not have to register for anything to be told it
 * will rain. The contract is deliberately narrow — one string, or null — so
 * every caller can treat weather as a nicety that may simply be absent.
 *
 * `todayWeather()` never throws and never blocks for long. A missing
 * configuration, a slow network, a reshaped payload, and a 500 all land in the
 * same place: `null`, and the brief is written without a weather line.
 */
import { DateTime } from 'luxon'
import { getConfig } from '../config.js'
import { logger } from '../logger.js'

const log = logger.child({ mod: 'weather' })

const ENDPOINT = 'https://api.open-meteo.com/v1/forecast'

/** Open-Meteo is generous, but the brief runs on a cron; do not lean on it. */
const TIMEOUT_MS = 6000

/** A forecast is good for a while. Repeated calls in one brief cost nothing. */
const CACHE_TTL_MS = 20 * 60 * 1000
/** A failure is cached too, briefly, so a retry storm cannot hammer the API. */
const FAILURE_TTL_MS = 2 * 60 * 1000

/** Hourly probability at or above this reads as "it will rain", not "it might". */
const WET_HOUR_THRESHOLD = 55
/** Daily maximum at or above this earns a hedged mention when no hour is wet. */
const CHANCE_THRESHOLD = 30
/** This many wet hours stops being "after 3pm" and becomes "most of the day". */
const ALL_DAY_WET_HOURS = 8
/** Nobody plans around a 4am shower. Hours before this are not the headline. */
const FIRST_INTERESTING_HOUR = 7

/* ────────────────────────────────── cache ────────────────────────────────── */

interface CacheEntry {
  at: number
  ttl: number
  value: string | null
}

let cache: CacheEntry | null = null

/* ─────────────────────────────── payload reading ─────────────────────────── */

/**
 * Everything below reads the payload defensively. Open-Meteo is stable, but a
 * proxy, an error envelope, or a future field rename must degrade to "no
 * weather line" rather than to a thrown TypeError inside a cron.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function numbersAt(source: Record<string, unknown> | null, key: string): Array<number | null> {
  const raw = source?.[key]
  if (!Array.isArray(raw)) return []
  return raw.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null))
}

function stringsAt(source: Record<string, unknown> | null, key: string): string[] {
  const raw = source?.[key]
  if (!Array.isArray(raw)) return []
  return raw.map((v) => (typeof v === 'string' ? v : ''))
}

function firstNumber(values: Array<number | null>): number | null {
  return values.length > 0 ? (values[0] ?? null) : null
}

/* ───────────────────────────── describing the sky ────────────────────────── */

/**
 * WMO 4677 weather codes, collapsed to the handful of phrases a person
 * actually wants at breakfast.
 */
function describeCode(code: number | null): string {
  if (code === null) return 'no forecast'
  if (code === 0) return 'clear'
  if (code === 1) return 'mostly clear'
  if (code === 2) return 'partly cloudy'
  if (code === 3) return 'overcast'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 51 && code <= 57) return 'drizzle'
  if (code >= 61 && code <= 67) return 'rain'
  if (code >= 71 && code <= 77) return 'snow'
  if (code >= 80 && code <= 82) return 'rain showers'
  if (code === 85 || code === 86) return 'snow showers'
  if (code >= 95) return 'thunderstorms'
  return 'mixed'
}

/** Snow and rain want different words for the same probability column. */
function precipitationNoun(codes: Array<number | null>): string {
  const wintry = codes.some(
    (code) => code !== null && ((code >= 71 && code <= 77) || code === 85 || code === 86),
  )
  return wintry ? 'snow' : 'rain'
}

/** 15 -> "3pm", 0 -> "12am", 9 -> "9am". */
function clockHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24
  const suffix = h < 12 ? 'am' : 'pm'
  const display = h % 12 === 0 ? 12 : h % 12
  return `${display}${suffix}`
}

/**
 * The precipitation clause, or null when nothing is worth saying.
 *
 * @param probabilities today's hourly chance of precipitation, index == hour
 * @param fromHour the current local hour; earlier hours are already history
 * @param dailyMax the day's peak probability, used for the hedged case
 */
function precipitationClause(
  probabilities: Array<number | null>,
  codes: Array<number | null>,
  fromHour: number,
  dailyMax: number | null,
): string | null {
  const noun = precipitationNoun(codes)
  const wetHours: number[] = []

  for (let hour = 0; hour < probabilities.length && hour < 24; hour += 1) {
    if (hour < fromHour) continue
    // The array is built by index and may be sparse, so a hole reads as
    // undefined rather than null — check the type, not just for null.
    const p = probabilities[hour]
    if (typeof p === 'number' && p >= WET_HOUR_THRESHOLD) wetHours.push(hour)
  }

  if (wetHours.length >= ALL_DAY_WET_HOURS) return `${noun} most of the day`

  const first = wetHours[0]
  if (first !== undefined) {
    if (first <= Math.max(fromHour, FIRST_INTERESTING_HOUR)) return `${noun} likely, starting early`
    return `${noun} likely after ${clockHour(first)}`
  }

  if (dailyMax !== null && dailyMax >= CHANCE_THRESHOLD) {
    return `a ${Math.round(dailyMax)}% chance of ${noun}`
  }
  return null
}

/* ─────────────────────────────── the public call ─────────────────────────── */

interface Coordinates {
  latitude: number
  longitude: number
  zone: string
}

/** Configured coordinates, or null when the household never set them. */
function coordinates(): Coordinates | null {
  let cfg: ReturnType<typeof getConfig>
  try {
    cfg = getConfig()
  } catch (err) {
    log.debug({ err }, 'no configuration available for the weather lookup')
    return null
  }
  if (!cfg.weatherConfigured) return null

  const latitude = Number(cfg.WEATHER_LATITUDE)
  const longitude = Number(cfg.WEATHER_LONGITUDE)
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    log.warn({ latitude: cfg.WEATHER_LATITUDE }, 'WEATHER_LATITUDE is not a usable latitude')
    return null
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    log.warn({ longitude: cfg.WEATHER_LONGITUDE }, 'WEATHER_LONGITUDE is not a usable longitude')
    return null
  }
  return { latitude, longitude, zone: cfg.HOUSEHOLD_TIMEZONE }
}

function buildUrl(at: Coordinates): string {
  const params = new URLSearchParams({
    latitude: at.latitude.toFixed(4),
    longitude: at.longitude.toFixed(4),
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    hourly: 'precipitation_probability,weather_code',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    // `auto` resolves the zone from the coordinates, so the hour labels below
    // are the hours at the house rather than UTC.
    timezone: 'auto',
    forecast_days: '1',
  })
  return `${ENDPOINT}?${params.toString()}`
}

/** The current hour at the house. Falls back to 0, which only widens the scan. */
function localHour(zone: string): number {
  const now = DateTime.now().setZone(zone)
  return now.isValid ? now.hour : DateTime.now().hour
}

function format(payload: unknown, zone: string): string | null {
  const root = asRecord(payload)
  if (!root) return null

  const daily = asRecord(root.daily)
  const hourly = asRecord(root.hourly)

  const high = firstNumber(numbersAt(daily, 'temperature_2m_max'))
  const low = firstNumber(numbersAt(daily, 'temperature_2m_min'))
  const dailyCode = firstNumber(numbersAt(daily, 'weather_code'))
  const dailyMax = firstNumber(numbersAt(daily, 'precipitation_probability_max'))

  // Today's date as the API itself labels it, so the hourly rows are filtered
  // against the location's calendar day rather than the server's.
  const today = stringsAt(daily, 'time')[0] ?? ''

  const hourTimes = stringsAt(hourly, 'time')
  const hourProbs = numbersAt(hourly, 'precipitation_probability')
  const hourCodes = numbersAt(hourly, 'weather_code')

  const probabilities: Array<number | null> = []
  const codes: Array<number | null> = []
  for (let i = 0; i < hourTimes.length; i += 1) {
    const stamp = hourTimes[i] ?? ''
    if (today && !stamp.startsWith(today)) continue
    const hour = Number.parseInt(stamp.slice(11, 13), 10)
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue
    probabilities[hour] = hourProbs[i] ?? null
    codes[hour] = hourCodes[i] ?? null
  }

  const parts: string[] = []
  if (low !== null && high !== null) {
    // En dash: this is a range, and the brief is read, not parsed.
    parts.push(`${Math.round(low)}–${Math.round(high)}°F`)
  } else if (high !== null) {
    parts.push(`high ${Math.round(high)}°F`)
  } else if (low !== null) {
    parts.push(`low ${Math.round(low)}°F`)
  }

  const wet = precipitationClause(probabilities, codes, localHour(zone), dailyMax)
  parts.push(wet ?? describeCode(dailyCode))

  const line = parts.filter(Boolean).join(', ')
  // "no forecast" on its own is not worth a line in the brief.
  if (line === '' || line === 'no forecast') return null
  return line
}

/**
 * One line of today's forecast, e.g. `58–71°F, rain likely after 3pm`.
 *
 * @returns the line, or null when no coordinates are configured, the request
 * fails or times out, or the payload cannot be read. Never throws.
 */
export async function todayWeather(): Promise<string | null> {
  const now = Date.now()
  if (cache && now - cache.at < cache.ttl) return cache.value

  const at = coordinates()
  if (!at) {
    // Nothing to retry: remember it for the normal TTL rather than the short one.
    cache = { at: now, ttl: CACHE_TTL_MS, value: null }
    return null
  }

  let line: string | null = null
  let failed = false

  try {
    const response = await fetch(buildUrl(at), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      log.warn({ status: response.status }, 'open-meteo returned an error status')
      failed = true
    } else {
      line = format(await response.json(), at.zone)
      if (line === null) {
        log.warn('open-meteo returned a payload with no usable forecast')
        failed = true
      }
    }
  } catch (err) {
    // Includes the AbortError from the timeout, DNS failures, and bad JSON.
    log.warn({ err }, 'weather lookup failed')
    failed = true
    line = null
  }

  cache = { at: Date.now(), ttl: failed ? FAILURE_TTL_MS : CACHE_TTL_MS, value: line }
  return line
}
