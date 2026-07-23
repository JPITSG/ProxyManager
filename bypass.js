'use strict';

/**
 * Bypass rules — per-proxy URL patterns whose requests connect directly.
 *
 * Shared by the background router (matching) and the popup form
 * (validation), so both always agree on what a rule means.
 *
 * Grammar — all parts optional, omitted parts match anything:
 *
 *   [scheme://]host[:port][/path][?query]
 *
 * `*` matches any run of characters within a part. Examples:
 *
 *   *.internal.example.com          host only — any scheme/port/path
 *   example.com                     the bare domain only
 *   localhost:8080                  host + port
 *   https://*.corp.com/*            scheme + host
 *   *://updates.example.com/admin*  path prefix
 *   *example.com*?*token=*          query string contents
 *   :8080                           any host on port 8080
 *
 * Semantics:
 *  - Within a rule all given parts must match (AND); across rules any
 *    match bypasses (OR).
 *  - `*.example.com` matches the base domain and all subdomains; a plain
 *    `example.com` matches only the bare domain.
 *  - Scheme and host are case-insensitive; path and query are not.
 *  - A port rule compares against the URL's effective port (80/443/… when
 *    the URL omits it).
 *  - A rule that fails to parse compiles to null and never matches.
 */

const Bypass = (() => {

  const DEFAULT_PORTS = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443, 'ftp:': 21 };

  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Turns a wildcard pattern (`*` = any run of characters) into an anchored
  // RegExp.
  function wildcardRe(pattern) {
    return new RegExp('^' + pattern.split('*').map(escapeRe).join('.*') + '$');
  }

  // Port pattern: `*` means any port (null); a valid port number; otherwise
  // -1 to mark the whole rule invalid.
  function parsePort(s) {
    if (s === '*') return null;
    if (/^\d{1,5}$/.test(s)) {
      const n = Number(s);
      if (n >= 1 && n <= 65535) return n;
    }
    return -1;
  }

  // Compiles one rule string to { scheme, host, port, path, query } where
  // each part is a RegExp (host: array of RegExp), a port number, or null
  // (= matches anything). Returns null when the rule cannot be parsed.
  function compileRule(raw) {
    if (typeof raw !== 'string') return null;
    let rest = raw.trim();
    if (!rest) return null;

    let scheme = null;
    const si = rest.indexOf('://');
    if (si !== -1) {
      const s = rest.slice(0, si);
      rest = rest.slice(si + 3);
      if (!s) return null;
      scheme = wildcardRe(s.toLowerCase());
    }

    let query = null;
    const qi = rest.indexOf('?');
    if (qi !== -1) {
      const q = rest.slice(qi + 1);
      rest = rest.slice(0, qi);
      if (q) query = wildcardRe(q);
    }

    let path = null;
    const pi = rest.indexOf('/');
    if (pi !== -1) {
      const p = rest.slice(pi + 1);
      rest = rest.slice(0, pi);
      if (p) path = wildcardRe('/' + p);
    }

    // What remains is host[:port]; an empty host means "any host".
    let hostPat = rest;
    let port = null;
    if (rest.startsWith('[')) {
      const m = rest.match(/^\[([^\]]*)\](?::(.*))?$/);
      if (!m) return null;
      hostPat = m[1];
      if (m[2] !== undefined) {
        port = parsePort(m[2]);
        if (port === -1) return null;
      }
    } else {
      const ci = rest.indexOf(':');
      if (ci !== -1) {
        hostPat = rest.slice(0, ci);
        port = parsePort(rest.slice(ci + 1));
        if (port === -1) return null;
      }
    }
    hostPat = hostPat.toLowerCase();

    let host = null;
    if (hostPat && hostPat !== '*') {
      if (hostPat.startsWith('*.')) {
        const base = hostPat.slice(2);
        if (!base) return null;
        // The base domain itself plus every subdomain.
        host = [wildcardRe(base), wildcardRe('*.' + base)];
      } else {
        host = [wildcardRe(hostPat)];
      }
    }

    return { scheme, host, port, path, query };
  }

  // Compiles a stored rule list, silently dropping rules that don't parse.
  function compileRules(list) {
    if (!Array.isArray(list)) return [];
    return list.map(compileRule).filter(Boolean);
  }

  // True when the URL matches any of the compiled rules.
  function matchUrl(rules, urlStr) {
    let u;
    try { u = new URL(urlStr); } catch (err) { return false; }
    const scheme = u.protocol.slice(0, -1).toLowerCase();
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const port = u.port ? Number(u.port) : (DEFAULT_PORTS[u.protocol] || null);
    const path = u.pathname || '/';
    const query = u.search ? u.search.slice(1) : '';
    return rules.some(r =>
      (!r.scheme || r.scheme.test(scheme)) &&
      (!r.host || r.host.some(re => re.test(host))) &&
      (r.port === null || r.port === port) &&
      (!r.path || r.path.test(path)) &&
      (!r.query || r.query.test(query))
    );
  }

  return { compileRule, compileRules, matchUrl };
})();
