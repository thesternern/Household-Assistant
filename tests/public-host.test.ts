import { describe, expect, it } from 'vitest'
import { isPrivateAddress, isPrivateHost } from '../src/net/public-host.js'

/**
 * The one guard every outside-steerable fetcher runs a host through. The
 * cases that matter are the spellings a naive check misses: the hex form of a
 * mapped IPv4 address, which is what Node's URL parser actually hands over,
 * and the whole link-local block rather than its first /16.
 */

const hostnameOf = (url: string): string => new URL(url).hostname

describe('isPrivateHost', () => {
  it('refuses loopback, private, link-local, CGNAT, and reserved IPv4 in every spelling', () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://127.1/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://0177.0.0.1/',
      'http://10.0.0.5/',
      'http://172.16.4.4/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://0.0.0.0/',
      'http://224.0.0.1/',
    ]) {
      expect(isPrivateHost(hostnameOf(url)), url).toBe(true)
    }
  })

  it('refuses an IPv4-mapped IPv6 literal in the hex form the URL parser produces', () => {
    // `new URL('http://[::ffff:127.0.0.1]/').hostname` is `[::ffff:7f00:1]`.
    expect(hostnameOf('http://[::ffff:127.0.0.1]/')).toBe('[::ffff:7f00:1]')
    for (const url of [
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://[::ffff:10.1.2.3]/',
      'http://[::1]/',
      'http://[::]/',
      'http://[64:ff9b::7f00:1]/',
    ]) {
      expect(isPrivateHost(hostnameOf(url)), url).toBe(true)
    }
  })

  it('refuses the whole link-local and unique-local IPv6 blocks, not only fe80: and fc/fd', () => {
    for (const host of ['fe80::1', 'fe9f::1', 'febf::1', 'fc00::1', 'fdff::1', 'ff02::1']) {
      expect(isPrivateHost(host), host).toBe(true)
    }
  })

  it('refuses names that only resolve locally', () => {
    for (const host of [
      'localhost',
      'printer.local',
      'db.internal',
      'postgres.railway.internal',
      'router.lan',
      'nas.home.arpa',
      'intranet',
    ]) {
      expect(isPrivateHost(host), host).toBe(true)
    }
  })

  it('allows an ordinary public name and a public address', () => {
    for (const host of ['cooking.nytimes.com', 'example.com', '93.184.216.34', '2606:4700::6810:84e5']) {
      expect(isPrivateHost(host), host).toBe(false)
    }
  })
})

describe('isPrivateAddress', () => {
  it('judges resolved addresses in both families', () => {
    expect(isPrivateAddress('10.0.0.1')).toBe(true)
    expect(isPrivateAddress('169.254.169.254')).toBe(true)
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true)
    expect(isPrivateAddress('fe80::1')).toBe(true)
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('2001:4860:4860::8888')).toBe(false)
    // Not an address at all: refuse.
    expect(isPrivateAddress('not-an-ip')).toBe(true)
  })
})
