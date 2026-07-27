# Proxy Manager

A Firefox extension to manage and switch between multiple proxy servers
with ease. Define any number of proxy profiles, color-code them, and flip
between them — or back to a direct connection — from the toolbar popup.

## Features

- **Multiple proxy profiles** — HTTP, HTTPS, SOCKS5 and SOCKS4, each with
  a name, host, port and optional color tag.
- **One-click switching** — pick a profile in the popup, or switch back to
  a direct connection; the toolbar icon takes on the active profile's
  color (gray means direct).
- **Reorderable list** — press, hold and drag a profile card to change
  the order; Ctrl+↑/↓ (or Alt+↑/↓) on a focused card does the same from
  the keyboard.
- **Authentication** — optional per-profile username/password, passed
  inline and answered automatically on HTTP 407 proxy auth challenges.
- **DNS control** — optional remote DNS resolution for SOCKS profiles.
- **LAN bypass** — optional per-profile switch to connect to local network
  hosts directly (loopback, private/link-local addresses, dotless and
  `.local` names), for both HTTP and HTTPS traffic.
- **URL bypass rules** — per-profile list of URL patterns that connect
  directly. One pattern per rule, `[scheme://]host[:port][/path][?query]`,
  `*` matches anything, omitted parts match all — e.g.
  `*.internal.example.com`, `localhost:8080`, `https://*.corp.com/admin*`.
- **Persistent profile** — mark one profile to be re-selected
  automatically at browser startup; otherwise the last used selection
  applies.
- **Connection test** — verify a profile before saving: requests to four
  IP-echo services race through the candidate proxy (everything else
  keeps the current routing); the first success reports latency and the
  exit IP, so one service being down or blocklisted cannot fail the test.
- **Backup & restore** — export all profiles to a JSON file; re-import
  from file or by drag & drop.
- **Themes** — system / light / dark popup appearance.
- **No analytics, no telemetry.**

## Requirements

- Firefox **140 or later** (desktop).

## Build from source

There is no bundled xpi — you build the package yourself. It is a plain
zip of the extension directory:

```sh
rm -f proxy-manager.xpi
zip -q -r -X proxy-manager.xpi background.js bypass.js icons LICENSE manifest.json popup
```

The built xpi is intentionally not tracked in git (see `.gitignore`).

## Install

- **Temporary (any Firefox, no build needed):** `about:debugging` →
  *This Firefox* → *Load Temporary Add-on…* → select `manifest.json`
  from this directory. Lasts until Firefox restarts.
- **Permanent:** Firefox only installs signed packages, so sign your own
  build through AMO's self-distribution channel (free, unlisted, no
  review) using API credentials from
  <https://addons.mozilla.org/developers/addon/api/key/>:

  ```sh
  npx web-ext sign --channel unlisted \
    --api-key <your-amo-issuer> --api-secret <your-amo-secret>
  ```

  then `about:addons` → gear icon → *Install Add-on From File…* and pick
  the signed xpi from `web-ext-artifacts/`.

## Project layout

- `manifest.json` — MV2 manifest: identity, permissions, data-collection
  declaration.
- `background.js` — owns the routing decision for every request
  (`browser.proxy.onRequest`), answers proxy auth challenges, recolors the
  toolbar icon, and runs the connection test.
- `bypass.js` — bypass-rule grammar shared by the router and the popup:
  compiles `[scheme://]host[:port][/path][?query]` wildcard patterns and
  matches request URLs against them.
- `popup/` — browser-action UI: profile list, add/edit/clone form with
  connection test, settings (theme, export/import).
- `icons/` — extension and toolbar icons.

## Privacy

The extension declares `none` under `data_collection_permissions` in the
manifest: it collects no data. Profiles and settings live only in
`browser.storage.local` on your device. The only outbound connections
beyond your configured proxies are the IP-echo requests (`api.ipify.org`,
`www.cloudflare.com/cdn-cgi/trace`, `ifconfig.me`,
`checkip.amazonaws.com`) made when you explicitly click *Test* on a
profile.

## License

MIT License — see `LICENSE`.
