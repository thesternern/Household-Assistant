import { describe, expect, it, vi } from 'vitest'

// send.ts touches the logger and (for primaryChatId) the database. Neither is
// involved in escaping or chunking, so both are stubbed out of the way.
vi.mock('../src/logger.js', () => {
  const noop = () => {}
  const l: Record<string, unknown> = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
  }
  l.child = () => l
  return { logger: l, child: () => l }
})

vi.mock('../src/db/client.js', async () => {
  const schema = await import('../src/db/schema.js')
  return {
    getDb: () => {
      throw new Error('no database in this test')
    },
    schema,
  }
})

const { escapeMd, chunk, md, MAX_MESSAGE_CHARS } = await import('../src/telegram/send.js')

/** Every character Telegram's MarkdownV2 parser treats as markup. */
const SPECIALS = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!']

describe('escapeMd', () => {
  it('escapes every MarkdownV2 special character', () => {
    for (const ch of SPECIALS) {
      expect(escapeMd(ch), `${ch} was not escaped`).toBe(`\\${ch}`)
    }
  })

  it('escapes all of them together, in order, losing nothing', () => {
    const raw = SPECIALS.join('')
    const escaped = escapeMd(raw)
    expect(escaped).toBe(SPECIALS.map((c) => `\\${c}`).join(''))
    expect(escaped.replace(/\\/g, '')).toBe(raw)
  })

  it('escapes the backslash itself so it cannot swallow the next character', () => {
    expect(escapeMd('a\\b')).toBe('a\\\\b')
    // "\!" in the input must not survive as a live escape sequence.
    expect(escapeMd('\\!')).toBe('\\\\\\!')
  })

  it('escapes every occurrence, not just the first', () => {
    expect(escapeMd('a.b.c')).toBe('a\\.b\\.c')
    expect(escapeMd('--')).toBe('\\-\\-')
  })

  it('leaves ordinary text, unicode and emoji alone', () => {
    expect(escapeMd('Dinner at 7 with Ana')).toBe('Dinner at 7 with Ana')
    expect(escapeMd('café 🍝')).toBe('café 🍝')
  })

  it('handles the empty string', () => {
    expect(escapeMd('')).toBe('')
  })
})

describe('md composers', () => {
  it('escapes the payload and adds only the markup it means to add', () => {
    expect(md.bold('a.b')).toBe('*a\\.b*')
    expect(md.italic('a_b')).toBe('_a\\_b_')
  })

  it('escapes backticks inside a code span', () => {
    expect(md.code('rm -rf `x`')).toBe('`rm -rf \\`x\\``')
  })

  it('fences a pre block with triple backticks and a newline on each side', () => {
    expect(md.pre('dish soap\n2 lb chicken thighs')).toBe('```\ndish soap\n2 lb chicken thighs\n```')
  })

  it('escapes backticks inside a pre block', () => {
    expect(md.pre('a `weird` item')).toBe('```\na \\`weird\\` item\n```')
  })

  it('escapes backslashes inside a pre block', () => {
    expect(md.pre('a\\b')).toBe('```\na\\\\b\n```')
  })

  it('escapes backtick and backslash together, in order, losing nothing', () => {
    const raw = '`\\`\\`'
    const fenced = md.pre(raw)
    expect(fenced).toBe('```\n\\`\\\\\\`\\\\\\`\n```')
    // Stripping the fence and the two escaped characters recovers the original.
    const inner = fenced.slice(4, -4)
    expect(inner.replace(/\\([`\\])/g, '$1')).toBe(raw)
  })

  it('leaves ordinary text, unicode and emoji alone', () => {
    expect(md.pre('café 🍝, 2 lb')).toBe('```\ncafé 🍝, 2 lb\n```')
  })

  it('handles the empty string', () => {
    expect(md.pre('')).toBe('```\n\n```')
  })
})

describe('chunk', () => {
  const big = (n: number, seed = 'The dog needs food. ') => {
    let out = ''
    while (out.length < n) out += seed
    return out.slice(0, n)
  }

  it('returns nothing for an empty message', () => {
    expect(chunk('')).toEqual([])
  })

  it('leaves a short message in one piece', () => {
    expect(chunk('hello')).toEqual(['hello'])
  })

  it('splits a 12000-character message into pieces of at most 4000 characters', () => {
    const text = big(12_000)
    const parts = chunk(text)

    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
  })

  it('loses no characters: the pieces concatenate back to the original', () => {
    const text = big(12_000)
    expect(chunk(text).join('')).toBe(text)
  })

  it('is lossless across paragraph, line and hard boundaries alike', () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}\n${big(400)}`).join(
      '\n\n',
    )
    const unbroken = big(12_000, 'x')
    const mixed = `${paragraphs}\n\n${unbroken}\n\nTail.`

    for (const text of [paragraphs, unbroken, mixed]) {
      const parts = chunk(text)
      expect(parts.join('')).toBe(text)
      for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
    }
  })

  it('prefers paragraph boundaries when they fit', () => {
    const a = big(3000, 'a')
    const b = big(3000, 'b')
    const parts = chunk(`${a}\n\n${b}`)

    expect(parts).toHaveLength(2)
    expect(parts[0]).toBe(`${a}\n\n`)
    expect(parts[1]).toBe(b)
  })

  it('falls back to line boundaries inside an oversized paragraph', () => {
    const line = `${big(1000, 'y')}\n`
    const parts = chunk(line.repeat(9))

    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
      // Every piece ends where a line ended, so no line is cut in half.
      expect(part.endsWith('\n')).toBe(true)
    }
  })

  it('never splits between a backslash and the character it escapes', () => {
    // A wall of escaped dots: every second character is a backslash, so a naive
    // cut at the limit would strand one.
    const escaped = escapeMd('.'.repeat(9000))
    const parts = chunk(escaped)

    expect(parts.join('')).toBe(escaped)
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
      // An odd run of trailing backslashes would mean a severed escape sequence.
      const trailing = /\\*$/.exec(part)?.[0].length ?? 0
      expect(trailing % 2).toBe(0)
    }
  })

  it('never splits a surrogate pair', () => {
    const parts = chunk('🍝'.repeat(5000))

    expect(parts.join('')).toBe('🍝'.repeat(5000))
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
      const first = part.charCodeAt(0)
      const last = part.charCodeAt(part.length - 1)
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    }
  })

  it('honours a custom limit', () => {
    const parts = chunk('abcdefghij'.repeat(10), 25)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(25)
    expect(parts.join('')).toBe('abcdefghij'.repeat(10))
  })
})
