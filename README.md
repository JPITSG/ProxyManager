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
- **Authentication** — optional per-profile username/password, passed
  inline and answered automatically on HTTP 407 proxy auth challenges.
- **DNS control** — optional remote DNS resolution for SOCKS profiles.
- **Persistent profile** — mark one profile to be re-selected
  automatically at browser startup; otherwise the last used selection
  applies.
- **Connection test** — verify a profile before saving: a single request
  to a lightweight IP-echo service is routed through the candidate proxy
  (everything else keeps the current routing) and reports latency and the
  exit IP.
- **Backup & restore** — export all profiles to a JSON file; re-import
  from file or by drag & drop.
- **Themes** — system / light / dark popup appearance.
- **No analytics, no telemetry.**

## Requirements

- Firefox **140 or later** (desktop).

## Install

- **From the signed package:** download `proxy-manager.xpi`, then
  `about:addons` → gear icon → *Install Add-on From File…*
- **For development:** `about:debugging` → *This Firefox* →
  *Load Temporary Add-on…* → select `manifest.json` from this directory.

## Build from source

The package is a plain zip of the extension directory (also what
CI/release tooling should produce):

```sh
zip -q -r -X proxy-manager.xpi background.js icons LICENSE manifest.json popup
```

The built xpi is intentionally not tracked in git (see `.gitignore`).

## Project layout

- `manifest.json` — MV2 manifest: identity, permissions, data-collection
  declaration.
- `background.js` — owns the routing decision for every request
  (`browser.proxy.onRequest`), answers proxy auth challenges, recolors the
  toolbar icon, and runs the connection test.
- `popup/` — browser-action UI: profile list, add/edit/clone form with
  connection test, settings (theme, export/import).
- `icons/` — extension and toolbar icons.

## Privacy

The extension declares `none` under `data_collection_permissions` in the
manifest: it collects no data. Profiles and settings live only in
`browser.storage.local` on your device. The only outbound connection
beyond your configured proxies is the IP-echo request
(`api.ipify.org`) made when you explicitly click *Test* on a profile.

## License

MIT License — see `LICENSE`.
