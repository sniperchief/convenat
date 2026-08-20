/**
 * URL normalisation and the address policy.
 *
 * These are the tests that decide whether evidence retrieval is a controlled
 * read or an SSRF primitive. They run entirely offline — no DNS, no sockets —
 * because a security control that can only be tested against the internet is a
 * control nobody re-tests.
 */

import { describe, expect, it } from 'vitest';

import {
  addressBlockedReason,
  assertAddressAllowed,
  normalizeSourceUrl,
  DEFAULT_URL_POLICY,
} from '../src/evidence/url-policy.js';
import { SourceRetrievalError } from '../src/evidence/types.js';

/** Assert a refusal and return its kind, so each case names its own reason. */
function refusalKind(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SourceRetrievalError);
    return (error as SourceRetrievalError).kind;
  }
  expect.unreachable('should have been refused');
  return '';
}

describe('normalizeSourceUrl: what is accepted', () => {
  it('keeps an ordinary https URL intact', () => {
    const url = normalizeSourceUrl('https://api.example.test/v1/track/1Z999');
    expect(url.href).toBe('https://api.example.test/v1/track/1Z999');
    expect(url.port).toBe(443);
    expect(url.fragmentStripped).toBe(false);
  });

  it('lowercases the host, because DNS is case-insensitive', () => {
    expect(normalizeSourceUrl('https://API.Example.TEST/x').href).toBe(
      'https://api.example.test/x',
    );
  });

  it('preserves query parameter order', () => {
    // Sorting would be a semantic change dressed up as normalisation: `?a=1&b=2`
    // and `?b=2&a=1` can mean different things to a real API.
    expect(normalizeSourceUrl('https://a.test/x?b=2&a=1').href).toBe('https://a.test/x?b=2&a=1');
  });

  it('is idempotent', () => {
    const once = normalizeSourceUrl('https://A.test/x#frag').href;
    expect(normalizeSourceUrl(once).href).toBe(once);
  });
});

describe('normalizeSourceUrl: identity', () => {
  it('strips a fragment, which is never sent to a server', () => {
    const url = normalizeSourceUrl('https://a.test/x#section-2');
    expect(url.href).toBe('https://a.test/x');
    expect(url.fragmentStripped).toBe(true);
  });

  it('gives a URL and the same URL with a fragment one identity', () => {
    expect(normalizeSourceUrl('https://a.test/x#one').href).toBe(
      normalizeSourceUrl('https://a.test/x#two').href,
    );
  });

  it('normalises an empty query away', () => {
    expect(normalizeSourceUrl('https://a.test/x?').href).toBe(
      normalizeSourceUrl('https://a.test/x').href,
    );
  });

  it('normalises dot segments and the default port', () => {
    expect(normalizeSourceUrl('https://a.test:443/v1/../v2/x').href).toBe('https://a.test/v2/x');
  });
});

describe('normalizeSourceUrl: what is refused', () => {
  it('refuses plain http rather than upgrading it', () => {
    // Silently promoting the scheme would change what the user approved.
    expect(refusalKind(() => normalizeSourceUrl('http://a.test/x'))).toBe('SOURCE_UNSUPPORTED');
  });

  it('refuses every non-https scheme', () => {
    for (const url of [
      'file:///etc/passwd',
      'file://C:/Windows/win.ini',
      'ftp://a.test/x',
      'gopher://a.test/x',
      'data:text/plain,hello',
      'jar:https://a.test/x!/y',
      'ws://a.test/x',
    ]) {
      expect(refusalKind(() => normalizeSourceUrl(url)), url).toBe('SOURCE_UNSUPPORTED');
    }
  });

  it('refuses a URL that is not absolute', () => {
    expect(refusalKind(() => normalizeSourceUrl('/relative/path'))).toBe('SOURCE_UNSUPPORTED');
    expect(refusalKind(() => normalizeSourceUrl('not a url'))).toBe('SOURCE_UNSUPPORTED');
  });

  it('refuses userinfo, which is a credential in a published document', () => {
    expect(refusalKind(() => normalizeSourceUrl('https://user:pass@a.test/x'))).toBe(
      'SOURCE_FORBIDDEN',
    );
    expect(refusalKind(() => normalizeSourceUrl('https://token@a.test/x'))).toBe(
      'SOURCE_FORBIDDEN',
    );
  });

  it('refuses a port outside the allowlist', () => {
    // The cheapest defence against a source URL reaching an internal service.
    for (const port of [22, 25, 3306, 5432, 6379, 8080, 11211]) {
      expect(refusalKind(() => normalizeSourceUrl(`https://a.test:${port}/x`)), String(port)).toBe(
        'SOURCE_FORBIDDEN',
      );
    }
  });

  it('accepts a widened port allowlist when an operator sets one', () => {
    expect(
      normalizeSourceUrl('https://a.test:8443/x', {
        ...DEFAULT_URL_POLICY,
        allowedPorts: [443, 8443],
      }).port,
    ).toBe(8443);
  });
});

describe('normalizeSourceUrl: the optional operator host allowlist', () => {
  const policy = { ...DEFAULT_URL_POLICY, allowedHosts: ['example.test', 'carrier.test'] };

  it('accepts an exact host and any subdomain of it', () => {
    expect(normalizeSourceUrl('https://example.test/x', policy).hostname).toBe('example.test');
    expect(normalizeSourceUrl('https://api.example.test/x', policy).hostname).toBe(
      'api.example.test',
    );
  });

  it('refuses a host outside it', () => {
    expect(refusalKind(() => normalizeSourceUrl('https://elsewhere.test/x', policy))).toBe(
      'SOURCE_FORBIDDEN',
    );
  });

  it('is not fooled by a suffix that is not a subdomain', () => {
    // `notexample.test` ends with `example.test` as a string but is a different
    // registrable name — the check is on label boundaries, not substrings.
    expect(refusalKind(() => normalizeSourceUrl('https://notexample.test/x', policy))).toBe(
      'SOURCE_FORBIDDEN',
    );
  });

  it('is off by default, because the ConditionSpec is the primary allowlist', () => {
    expect(DEFAULT_URL_POLICY.allowedHosts).toEqual([]);
    expect(() => normalizeSourceUrl('https://anything.test/x')).not.toThrow();
  });
});

describe('address policy: IPv4', () => {
  const blocked: ReadonlyArray<readonly [string, string]> = [
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'the whole 127/8 range, not just .0.1'],
    ['0.0.0.0', 'this network'],
    ['10.0.0.7', 'private'],
    ['172.16.0.1', 'private, low edge'],
    ['172.31.255.254', 'private, high edge'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'the cloud instance metadata endpoint'],
    ['169.254.1.1', 'link-local generally'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['192.0.0.1', 'IETF protocol assignments'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
  ];

  for (const [address, why] of blocked) {
    it(`refuses ${address} (${why})`, () => {
      expect(addressBlockedReason(address)).not.toBeNull();
      expect(() => assertAddressAllowed(address)).toThrow(SourceRetrievalError);
    });
  }

  it('allows ordinary public addresses', () => {
    for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '172.15.255.255']) {
      expect(addressBlockedReason(address), address).toBeNull();
    }
  });

  it('does not treat a neighbouring range as private', () => {
    // 172.16/12 is 172.16–172.31. A mask computed one bit wrong would swallow
    // 172.32, which is public.
    expect(addressBlockedReason('172.32.0.1')).toBeNull();
    expect(addressBlockedReason('172.15.0.1')).toBeNull();
    expect(addressBlockedReason('100.63.255.255')).toBeNull();
    expect(addressBlockedReason('100.128.0.1')).toBeNull();
  });
});

describe('address policy: IPv6', () => {
  const blocked: ReadonlyArray<readonly [string, string]> = [
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local with a zone index'],
    ['fc00::1', 'unique local'],
    ['fd12:3456:789a::1', 'unique local, the commonly generated form'],
    ['ff02::1', 'multicast'],
    ['2002:7f00:1::', '6to4 tunnel'],
    ['100::1', 'discard-only'],
  ];

  for (const [address, why] of blocked) {
    it(`refuses ${address} (${why})`, () => {
      expect(addressBlockedReason(address), address).not.toBeNull();
    });
  }

  it('unwraps an IPv4-mapped address and applies the IPv4 policy', () => {
    // Without this, the entire IPv4 table above is bypassed by writing
    // ::ffff:127.0.0.1 instead of 127.0.0.1.
    expect(addressBlockedReason('::ffff:127.0.0.1')).not.toBeNull();
    expect(addressBlockedReason('::ffff:169.254.169.254')).not.toBeNull();
    expect(addressBlockedReason('::ffff:10.0.0.1')).not.toBeNull();
    expect(addressBlockedReason('::ffff:8.8.8.8')).toBeNull();
  });

  it('unwraps a NAT64 address for the same reason', () => {
    expect(addressBlockedReason('64:ff9b::127.0.0.1')).not.toBeNull();
    expect(addressBlockedReason('64:ff9b::169.254.169.254')).not.toBeNull();
  });

  it('allows an ordinary public IPv6 address', () => {
    expect(addressBlockedReason('2606:4700:4700::1111')).toBeNull();
    expect(addressBlockedReason('2001:4860:4860::8888')).toBeNull();
  });

  it('refuses anything it cannot parse rather than allowing it', () => {
    // Fail closed: an address this code does not understand is not an address
    // it may connect to.
    for (const nonsense of ['', 'localhost', '::ffff::1', 'g::1', '1.2.3', '999.1.1.1']) {
      expect(addressBlockedReason(nonsense), nonsense).not.toBeNull();
    }
  });
});
