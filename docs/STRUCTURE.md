# Project structure

```
KeepWatch/
├── Dockerfile, docker/              Single-container image, entrypoint that drops root
├── docker-compose.yml               Compose file for the published image (-local builds from source)
├── drizzle/                         SQL migrations, applied on startup
├── drizzle.config.ts                drizzle-kit config (bun run db:generate)
├── vite.config.ts, components.json  Web UI and demo build, shadcn/ui config
├── src/
│   ├── shared/                      Code used by both server and UI
│   │   ├── keepalived.ts            Spec sent to agents, validation, reported status
│   │   ├── clusters.ts              VIP, check and cluster input and their rules
│   │   ├── events.ts                Event types, labels, severities, template variables
│   │   ├── channels.ts              Notification channel types and their config fields
│   │   ├── templates.ts             Template rendering and example events
│   │   ├── template-presets.ts      Ready-made template sets
│   │   ├── demo-data.ts             Made-up data for the demo and screenshots
│   │   └── log-buffer.ts, time.ts, version.ts, sort.ts
│   ├── server/
│   │   ├── index.ts                 Entry point: Hono app, WebSocket, background jobs
│   │   ├── env.ts, logger.ts        Env vars, generated secrets, JSON logging, log buffer
│   │   ├── settings.ts, secrets.ts  App settings, encryption box and server signing key
│   │   ├── events.ts, cli.ts        Event log, recovery commands
│   │   ├── http/                    Security headers and the same-origin check
│   │   ├── db/                      Drizzle schema and SQLite client
│   │   ├── auth/                    Better Auth and two-factor setup, login events, sessions
│   │   ├── crypto/                  AES-GCM secret box, Ed25519 signing, X25519 sealing
│   │   ├── agents/                  Agent protocol, enrollment, WebSocket hub, release checks
│   │   ├── keepalived/              Node specs, state tracking and alerts, plan and rollout
│   │   ├── notify/                  Channel config, providers, templates, delivery retries
│   │   └── routes/                  REST API for the UI and public agent endpoints
│   └── web/                         React UI
│       ├── components/              Layout, shared components, shadcn/ui primitives
│       ├── demo/                    In-browser fake API for the demo build
│       ├── lib/                     API client, auth client, types, formatting, theme
│       └── pages/                   Dashboard, Clusters, Nodes, Events, Channels, Logs, Settings, auth
├── agent/                           Go agent with its install and uninstall scripts
│   ├── internal/core/               Pairing, connection, signed commands, sealed values, updates, service file
│   ├── internal/keepalived/         Spec, config rendering, apply and rollback, status, checks, import
│   └── cmd/keepwatch-agent/         Agent command and its handlers
├── tests/                           bun test suites
├── scripts/                         README screenshot generator
├── docs/                            Configuration, build guide, versioning, database, screenshots and logo
└── .github/workflows/               build (checks, Docker image, server release), agent release
```
