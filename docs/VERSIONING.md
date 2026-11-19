# Versioning

The server and the agent have separate versions and releases. Both use `X.Y.Z`.

| Component   | Tag            | Publishes                                                            |
| ----------- | -------------- | -------------------------------------------------------------------- |
| Server + UI | `vX.Y.Z`       | `ghcr.io/tfourj/keepwatch` image (amd64, arm64) and a GitHub release |
| Agent       | `agent-vX.Y.Z` | GitHub release with agent binaries, install scripts and checksums    |

```bash
git tag -a v1.2.3 -m "KeepWatch v1.2.3" && git push origin v1.2.3
git tag -a agent-v1.2.3 -m "KeepWatch agent v1.2.3" && git push origin agent-v1.2.3
```

- Server releases are the repository's **latest** release. Agent releases never are.
- Installs, agent updates and the server's update check use the newest `agent-vX.Y.Z` release, found through the
  GitHub API.
- Agent and server versions do not need to match. The agent's `protocol_version` in `agent-release.json` decides
  compatibility, and the server ignores agent releases with a different protocol.
- Server builds of a commit without a `vX.Y.Z` tag show the short commit instead of a version.
