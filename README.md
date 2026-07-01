# Dmarcontrol

Self-hosted DMARC aggregate report viewer for teams that want local storage, fast inspection, and a small operational footprint.

[![Docker image](https://github.com/adminsyspro/dmarcontrol/actions/workflows/docker-image.yml/badge.svg)](https://github.com/adminsyspro/dmarcontrol/actions/workflows/docker-image.yml)

---

## Overview

Dmarcontrol imports DMARC aggregate XML reports, normalizes them into SQLite, and serves a single embedded web dashboard from a Rust binary. It is designed for operators who need to understand DMARC alignment, identify sending sources, and move domains safely from monitoring toward enforcement.

Use it as:

- A day-to-day dashboard for DMARC aggregate report review.
- A local archive for `.xml`, `.xml.gz`, and `.zip` DMARC reports.
- A remediation workspace for SPF/DKIM alignment issues.
- A lightweight mailbox importer for DMARC report attachments.

---

## Quick Start

### Docker

```bash
docker run -d \
  --name dmarcontrol \
  -p 8080:8080 \
  -v dmarcontrol-data:/app/data \
  -e DMARCONTROL_ADMIN_PASSWORD='change-me' \
  -e DMARCONTROL_APP_SECRET='replace-with-a-long-random-secret' \
  --restart unless-stopped \
  ghcr.io/adminsyspro/dmarcontrol:latest
```

Then open `http://your-server:8080`.

Default local username is `admin`. If `DMARCONTROL_ADMIN_PASSWORD` is not set before the first start, the first local admin password defaults to `admin`.

### Docker Compose

```bash
cp .env.example .env
$EDITOR .env
docker compose up -d
```

The provided `docker-compose.yml` persists application data in the `dmarcontrol-data` volume.

### From source

```bash
cargo run -- --addr 127.0.0.1:8080
```

Open `http://localhost:8080`.

---

## Persistence & Secrets

Dmarcontrol stores application state in SQLite under the data directory:

```text
/app/data/dmarcontrol.sqlite
```

Mount `/app/data` when running in Docker so users, sessions, mailbox settings, and imported reports survive image updates.

### Required production secrets

| Variable | Purpose | Safe to rotate? |
| --- | --- | --- |
| `DMARCONTROL_APP_SECRET` | Signs and encrypts application session data | Yes, but active sessions are invalidated |
| `DMARCONTROL_ADMIN_PASSWORD` | Seeds the initial local admin password on first boot | Only before the first user exists |

Generate a strong secret with:

```bash
openssl rand -base64 48
```

Back up the Docker volume. Losing the SQLite database means losing imported reports and saved settings.

---

## Features

| Feature | Description |
| --- | --- |
| DMARC import | Import `.xml`, `.xml.gz`, `.gz`, `.zip`, files, and directories |
| Web upload | Upload aggregate reports directly from the dashboard |
| Mailbox sync | Pull DMARC report attachments from IMAP, manually or on a schedule |
| Compliance trend | View message volume and aligned traffic over 24h, 7d, 30d, or 1y |
| Global search | Search domains, sender emails, source IPs, reports, and remediation evidence |
| Domain intelligence | Inspect policy strength, alignment rate, sources, and recent reports per domain |
| Source analysis | Rank sending IPs by message volume, alignment, rejection, and risk |
| Remediation queue | Get prioritized action items before tightening DMARC policy |
| Geo enrichment | Enrich source IPs with country, continent, ASN, and map points using IP66 MMDB |
| CSV export | Export report evidence as CSV |
| Authentication | Local admin login plus optional OIDC single sign-on |
| Embedded UI | No frontend build pipeline or external runtime once compiled |
| Local storage | SQLite only; no database server required |
| Dark mode | Full light/dark interface |

---

## Configuration

### Runtime

| Variable | Default | Description |
| --- | --- | --- |
| `ADDR` | `127.0.0.1:8080` | Listen address. Docker sets `0.0.0.0:8080`. |
| `DATA_DIR` | `data` | Directory containing SQLite data and optional GeoIP DB. |
| `DMARCONTROL_GEOIP_DB` | `$DATA_DIR/ip66.mmdb` | Path to the IP66 MMDB file. |
| `DMARCONTROL_APP_SECRET` | development fallback | Secret used for signed/encrypted app state. Set in production. |
| `DMARCONTROL_FORCE_HTTPS` | `false` | Adds the Secure flag to session cookies when set to `true`. |
| `DMARCONTROL_PUBLIC_BASE_URL` | current request host | Public base URL used for OIDC callback generation. |
| `DMARCONTROL_ADMIN_USERNAME` | `admin` | Initial local admin username. |
| `DMARCONTROL_ADMIN_PASSWORD` | `admin` | Initial local admin password if no users exist. |

### Mailbox import

| Variable | Default | Description |
| --- | --- | --- |
| `DMARCONTROL_IMAP_HOST` | required for env-based import | IMAP server hostname |
| `DMARCONTROL_IMAP_PORT` | `993` | IMAP TLS port |
| `DMARCONTROL_IMAP_USERNAME` | required for env-based import | IMAP username |
| `DMARCONTROL_IMAP_PASSWORD` | required for env-based import | IMAP password or app password |
| `DMARCONTROL_IMAP_MAILBOX` | `INBOX` | Mailbox folder |
| `DMARCONTROL_IMAP_UNSEEN_ONLY` | `true` | Import unread messages only |
| `DMARCONTROL_IMAP_MARK_SEEN` | `false` | Mark messages as read after sync |
| `DMARCONTROL_IMAP_MAX_MESSAGES` | `500` | Maximum messages scanned per run |
| `DMARCONTROL_IMAP_SINCE_HOURS` | `24` | Message lookback window |

Mailbox settings can also be managed from the web UI.

---

## IP Geolocation

Dmarcontrol can enrich source IPs with the free IP66 MMDB database.

```bash
mkdir -p data
curl -L -o data/ip66.mmdb https://downloads.ip66.dev/db/ip66.mmdb
```

Docker:

```bash
docker run --rm -v dmarcontrol-data:/data curlimages/curl:latest \
  -L -o /data/ip66.mmdb https://downloads.ip66.dev/db/ip66.mmdb
```

---

## Importing Reports

Import from disk:

```bash
cargo run -- --import ./reports
```

Import with Docker:

```bash
docker run --rm \
  -v dmarcontrol-data:/app/data \
  -v "$PWD/reports:/reports:ro" \
  ghcr.io/adminsyspro/dmarcontrol:latest \
  dmarcontrol --import /reports --data-dir /app/data
```

Run a one-shot mailbox import:

```bash
cargo run -- --import-mailbox
```

---

## API

Authenticated endpoints:

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/statistics` | Aggregate counters |
| `GET` | `/api/overview` | Dashboard overview |
| `GET` | `/api/domains` | Domain summaries |
| `GET` | `/api/domains/{domain}` | Domain detail |
| `GET` | `/api/action-items` | Remediation items |
| `GET` | `/api/timeline` | Compliance timeline |
| `GET` | `/api/geo-sources` | Geolocated source IPs |
| `GET` | `/api/reports` | Report summaries |
| `GET` | `/api/reports/{id}` | Full normalized report |
| `GET` | `/api/search?q=...` | Global search |
| `GET` | `/api/top-sources` | Source IP insight |
| `POST` | `/api/import` | Multipart upload, field `file` |
| `POST` | `/api/mailbox/import` | Trigger mailbox sync |

Public endpoint:

```text
GET /healthz
```

---

## Reverse Proxy

Example Nginx vhost:

```nginx
server {
    listen 443 ssl;
    server_name dmarcontrol.example.com;

    ssl_certificate     /etc/letsencrypt/live/dmarcontrol.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dmarcontrol.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

When serving over HTTPS, set:

```bash
DMARCONTROL_FORCE_HTTPS=true
DMARCONTROL_PUBLIC_BASE_URL=https://dmarcontrol.example.com
```

---

## DMARC DNS Reminder

Start with monitoring:

```text
_dmarc.example.com TXT "v=DMARC1; p=none; rua=mailto:dmarc@example.com"
```

Review reports, fix SPF/DKIM alignment, then move gradually toward `quarantine` and `reject`.

---

## Requirements

- Docker and Docker Compose for container deployments.
- Rust stable toolchain with `cargo` for source builds.
- Optional IMAP mailbox dedicated to DMARC aggregate reports.

---

## License

MIT.
