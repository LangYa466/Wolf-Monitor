# Security Policy

## Reporting a Vulnerability

If you believe you've found a security issue in Wolf-Monitor, please **do not**
open a public GitHub issue. Instead, report it privately to:

- **Email:** langya466@gmail.com
- **GitHub:** open a [private security advisory](https://github.com/LangYa466/Wolf-Monitor/security/advisories/new)

Please include:

- A description of the issue and its impact.
- Steps to reproduce (PoC, request samples, affected endpoints).
- The commit / release version you tested against.

You can expect an acknowledgement within **72 hours** and a status update
within **7 days**. We aim to ship a fix or mitigation within **30 days** for
high-severity issues. Please give us a reasonable window to patch before any
public disclosure.

## Supported Versions

Only the latest tagged release on the `main` branch receives security fixes.
Older versions should be upgraded.

## Scope

In scope:

- `master/` — Next.js dashboard, API routes, WebSocket ingestion (`server.ts`).
- `node/` — Go agent (`wolf-node`).
- Default install scripts (`install.sh`, `install.ps1`).

Out of scope:

- Issues caused by user-supplied configuration (e.g. publicly exposed
  `DATABASE_URL`, weak admin password, disabled TLS).
- Findings against forks or third-party deployments that have diverged from
  this repository.

## Operations & Key Rotation

See [`master/README.md`](master/README.md#operations--key-rotation) for the
runbook covering token rotation, credential rotation, database backup &
restore, session invalidation, and binary integrity verification.
