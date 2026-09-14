import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'

/**
 * One answer to "may this process open a connection to that host?"
 *
 * Three fetchers take URLs that outside text can steer — the recipe scraper,
 * the recipe store's import path, and the ICS feed watcher — and each grew its
 * own private-address check. They drifted: one missed the hex spelling of an
 * IPv4-mapped IPv6 literal, one matched only `fe80:` out of the whole
 * link-local block, and their name suffix lists disagreed. A guard that lives
 * in three places is three guards to get wrong, so this is the one.
 *
 * Two layers:
 *
 *  1. {@link isPrivateHost} judges the literal host in the URL — names that
 *     only resolve locally, and every spelling of a loopback, private,
 *     link-local, multicast, or reserved address in either IP family.
 *  2. {@link resolvesToPrivate} asks the resolver where a public-looking name
 *     actually points, so a record an attacker controls cannot aim a fetch at
 *     the metadata service or the LAN. It cannot close a true rebinding race
 *     (a record that flips between this lookup and the socket's own); that
 *     needs a connect-time check inside the HTTP client, which Node's `fetch`
 *     does not expose. It does close the ordinary case, which is a static
 *     record, and it says so in the log when it fires.
 */

/** Names that never leave the machine or the local network. */
const LOCAL_NAMES: ReadonlySet<string> = new Set(['localhost', 'ip6-localhost', 'ip6-loopback'])

/** Suffixes that only resolve on a local network — mDNS, cloud-internal DNS, home routers. */
const LOCAL_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.home.arpa',
  '.railway.internal',
] as const

function stripBrackets(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '')
}

/** Loopback, this-network, private, link-local (incl. cloud metadata), CGNAT, multicast, reserved. */
function isPrivateIpv4(address: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address)
  if (m === null) return false
  const octets = m.slice(1).map(Number)
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return true
  const [a = 0, b = 0] = octets
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

/**
 * Expand an IPv6 address to its eight 16-bit groups, or null when it is not one.
 * An embedded dotted IPv4 tail (`::ffff:127.0.0.1`) is folded into the last two
 * groups, so the two spellings of a mapped address compare equal.
 */
function ipv6Groups(address: string): number[] | null {
  if (isIP(address) !== 6) return null
  let text = address
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)

  const tail = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text)
  if (tail?.[1] !== undefined) {
    const octets = tail[1].split('.').map(Number)
    const hi = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0)
    const lo = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0)
    text = `${text.slice(0, tail.index)}:${hi.toString(16)}:${lo.toString(16)}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] === '' || halves[0] === undefined ? [] : halves[0].split(':')
  const rest = halves[1] === undefined || halves[1] === '' ? [] : halves[1].split(':')
  const missing = 8 - head.length - rest.length
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null
  const groups = [...head, ...Array<string>(missing).fill('0'), ...rest].map((g) => Number.parseInt(g, 16))
  if (groups.length !== 8 || groups.some((g) => !Number.isFinite(g))) return null
  return groups
}

/** Unspecified, loopback, mapped/translated IPv4 (judged as IPv4), unique-local, link-local, multicast. */
function isPrivateIpv6(address: string): boolean {
  const g = ipv6Groups(address)
  if (g === null) return true // not an address we can read: refuse
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g
  const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0
  if (leadingZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true // :: and ::1
  if (leadingZero && g5 === 0xffff) return isPrivateIpv4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`) // ::ffff:a.b.c.d
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIpv4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`) // 64:ff9b::/96 NAT64
  }
  if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10 link local
  if ((g0 & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

/** True when a resolved IP address (either family) must not be connected to. */
export function isPrivateAddress(address: string): boolean {
  const ip = stripBrackets(String(address ?? '').trim().toLowerCase())
  const family = isIP(ip)
  if (family === 4) return isPrivateIpv4(ip)
  if (family === 6) return isPrivateIpv6(ip)
  return true
}

/**
 * True when the literal host of a URL must not be fetched.
 *
 * Takes `URL.hostname`, which Node has already lowercased, punycoded, and
 * canonicalised (`http://2130706433/` arrives as `127.0.0.1`). Anything that is
 * neither a public-looking name nor a public IP answers true.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = stripBrackets(String(hostname ?? '').trim().toLowerCase()).replace(/\.+$/, '')
  if (host === '') return true
  if (LOCAL_NAMES.has(host)) return true
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true

  const family = isIP(host)
  if (family === 4) return isPrivateIpv4(host)
  if (family === 6) return isPrivateIpv6(host)

  // Numeric-but-not-an-address (`127.1`, `0x7f.1`, `0177.0.0.1`): an alternate
  // spelling the resolver would accept. A name has a letter in it somewhere.
  if (/^[\d.]+$/.test(host) || /^0x[0-9a-f.]+$/i.test(host)) return true
  // A bare name with no dot only resolves on the local network.
  if (!host.includes('.')) return true
  return false
}

/** How long the pre-flight lookup may take before it is skipped. */
const LOOKUP_TIMEOUT_MS = 1_500

/** Per-process memo so a list of URLs on one host pays for one lookup. */
const LOOKUP_TTL_MS = 60_000
const lookups = new Map<string, { at: number; privateAddress: string | null }>()

/**
 * The address a public-looking name resolves to, if it is private.
 *
 * Returns the offending address, or null when every resolved address is
 * public — or when the lookup failed or timed out. Failing open there is
 * deliberate: a name that does not resolve cannot be fetched either, and a
 * slow resolver must not turn every recipe import into a timeout. What this
 * closes is the plain case, an attacker's record that points at 10.x or the
 * metadata service.
 */
export async function resolvesToPrivate(hostname: string): Promise<string | null> {
  const host = stripBrackets(String(hostname ?? '').trim().toLowerCase()).replace(/\.+$/, '')
  if (host === '' || isIP(host) !== 0) return null

  const cached = lookups.get(host)
  if (cached !== undefined && Date.now() - cached.at < LOOKUP_TTL_MS) return cached.privateAddress

  let privateAddress: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const addresses = await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('lookup timed out')), LOOKUP_TIMEOUT_MS)
        timer.unref()
      }),
    ])
    for (const entry of addresses) {
      if (isPrivateAddress(entry.address)) {
        privateAddress = entry.address
        break
      }
    }
  } catch {
    privateAddress = null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }

  if (lookups.size > 500) lookups.clear()
  lookups.set(host, { at: Date.now(), privateAddress })
  return privateAddress
}

/** Test seam: forget memoised lookups. */
export function __resetLookupCacheForTests(): void {
  lookups.clear()
}
