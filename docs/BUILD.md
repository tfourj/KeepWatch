# Building and Development

## Build the image from source

```bash
BASE_URL=https://keepwatch.example.com docker compose -f docker-compose-local.yml up -d --build
```

## Development

Requires [Bun](https://bun.sh) and, for the agent, [Go](https://go.dev).

```bash
bun install
bun run dev        # API on port 4321
bun run dev:web    # UI on port 5173, /api proxied to 4321
```

Other scripts:

```bash
bun run test         # tests
bun run typecheck    # TypeScript
bun run build        # frontend into dist/web
bun run db:generate  # create a migration after editing src/server/db/schema.ts
cd agent && go test ./...
```

## Releases

The server and the agent are tagged and released separately, see [VERSIONING.md](VERSIONING.md).

## Demo site

`bun run build:demo` builds a static demo into `dist/demo`. It is the normal UI with the API answered in the browser
by `src/web/demo/api.ts`, using the made-up data in `src/shared/demo-data.ts`. Changes stay in memory and reset on
reload. Failover and maintenance move the master; anything that needs a real node shows "not available in the
demo". Normal builds and the Docker image do not include any of it.

To host it on Cloudflare Pages, create a Pages project from the GitHub repository with:

| Setting                | Value                                                 |
| ---------------------- | ----------------------------------------------------- |
| Build command          | `bun install --frozen-lockfile && bun run build:demo` |
| Build output directory | `dist/demo`                                           |
| Root directory         | `/`                                                   |

The build includes a `_redirects` file so routes like `/events` work on reload. Run it locally with
`bun run dev:demo`.

## Screenshots

The README screenshots are taken from the demo build. Only Docker is needed:

```bash
sh scripts/screenshots.sh        # dark mode, or pass light
```

See [STRUCTURE.md](STRUCTURE.md) for the code layout and [DATABASE.md](DATABASE.md) for the schema.
