# Dmarcontrol

Dmarcontrol is a lightweight, self-hosted DMARC aggregate report viewer written in Rust. It imports DMARC XML reports from `.xml`, `.xml.gz`, and `.zip` files, stores normalized data locally, and serves a small dashboard from the same binary.

The project is inspired by tools like `dmarcguardhq/dmarcguard`, but the implementation here is original and intentionally small: no database server, no frontend build step, and no external runtime dependencies once compiled.

## Features

- Import DMARC aggregate XML reports from files, archives, or directories.
- Upload reports from the web dashboard.
- Dashboard with total volume, compliance rate, policy actions, source IPs, and report list.
- SQLite storage under `./data/dmarcontrol.sqlite` by default.
- Single Rust HTTP service with embedded static assets.
- Hope UI / Bootstrap 5 based admin interface.
- Optional IMAP mailbox import for DMARC report attachments.
- IP66 MMDB-based source IP country, continent, and ASN enrichment.

## Requirements

- Rust stable toolchain with `cargo`.

## Quick Start

```bash
cargo run -- --addr 127.0.0.1:8080
```

Open `http://localhost:8080`.

Import existing reports from disk:

```bash
cargo run -- --import ./reports
```

Use a custom data directory:

```bash
DATA_DIR=/var/lib/dmarcontrol cargo run -- --addr 127.0.0.1:8080
```

## IP Geolocation

Dmarcontrol can enrich source IPs with the free IP66 MMDB database. Download the database into the data directory:

```bash
curl -L -o data/ip66.mmdb https://downloads.ip66.dev/db/ip66.mmdb
```

By default the app reads `data/ip66.mmdb`. You can override the path with:

```bash
cargo run -- --geoip-db /path/to/ip66.mmdb
```

IP66 provides country, continent, and ASN data. The map places country-level points using country centroids.

## Mailbox Import

Dmarcontrol can connect to an IMAP mailbox, scan DMARC report emails, extract `.xml`, `.xml.gz`, `.gz`, and `.zip` attachments, then import them into SQLite.

Required configuration:

```bash
export DMARCONTROL_IMAP_HOST=imap.example.com
export DMARCONTROL_IMAP_USERNAME=dmarc@example.com
export DMARCONTROL_IMAP_PASSWORD='app-password'
```

Optional configuration:

```bash
export DMARCONTROL_IMAP_PORT=993
export DMARCONTROL_IMAP_MAILBOX=INBOX
export DMARCONTROL_IMAP_UNSEEN_ONLY=true
export DMARCONTROL_IMAP_MARK_SEEN=false
export DMARCONTROL_IMAP_MAX_MESSAGES=500
export DMARCONTROL_IMAP_SINCE_HOURS=24
```

Run a one-shot mailbox import:

```bash
cargo run -- --import-mailbox
```

Or start the web app and trigger mailbox import from the dashboard with `Sync mailbox`, which calls:

```text
POST /api/mailbox/import
```

## API

- `GET /api/statistics`
- `GET /api/overview`
- `GET /api/domains`
- `GET /api/action-items`
- `GET /api/timeline`
- `GET /api/geo-sources`
- `GET /api/reports`
- `GET /api/reports/{id}`
- `GET /api/top-sources`
- `POST /api/import` with multipart field `file`
- `POST /api/mailbox/import`
- `GET /healthz`

## DMARC DNS Reminder

To receive aggregate reports, publish a TXT record like:

```text
_dmarc.example.com TXT "v=DMARC1; p=none; rua=mailto:dmarc@example.com"
```

Start with `p=none`, review the reports, fix SPF/DKIM alignment problems, then move gradually toward `quarantine` or `reject`.
