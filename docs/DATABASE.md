# Database Schema

SQLite via Drizzle ORM. The schema lives in `src/server/db/schema.ts`, migrations are generated into `drizzle/`
and applied automatically on startup. Timestamps are stored as Unix milliseconds.

Values marked *encrypted* are AES-256-GCM ciphertext (key derived from `ENCRYPTION_SECRET`).

## Auth (Better Auth)

| Table          | Purpose                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| `user`         | The one account. A trigger refuses a second row                              |
| `session`      | Login sessions, with `last_active_at` and `last_ip`                          |
| `account`      | Password hash                                                                |
| `verification` | Short-lived verification tokens, 2FA challenges and trusted devices          |
| `two_factor`   | TOTP secret and backup codes, encrypted with `BETTER_AUTH_SECRET`            |

## Settings

**`settings`** key/value pairs: `app` holds the settings JSON, `server_signing_key` the *encrypted* Ed25519 key that
signs agent commands.

## Nodes and agents

**`nodes`**

| Column              | Notes                                                       |
| ------------------- | ----------------------------------------------------------- |
| `cluster_id`        | FK `clusters.id`, null outside a cluster                    |
| `config_mode`       | `managed`, `monitor`, or null until set up                  |
| `online`, `last_seen_at` |                                                        |
| `status`            | Last keepalived report from the agent (JSON)                |
| `problems`          | Problems already notified, so each is sent once             |
| `migrate_instances` | Imported `vrrp_instance` names the next apply comments out  |
| `applied_spec_hash` | Hash of the config last applied, to show nodes that are behind |

**`agents`** one per node: `public_key` (Ed25519, signs the hello), `seal_key` (X25519, secrets are sealed to it),
version, os, arch, hostname, interfaces, update state and `auto_update`.

**`enrollment_tokens`** one-time install tokens, stored as SHA-256 only, 15 minutes valid.

**`commands`** signed commands sent to agents, with status, expiry and error.

## Clusters and VIPs

**`clusters`** name and description.

**`vrrp_instances`** one per VIP

| Column              | Notes                                                    |
| ------------------- | -------------------------------------------------------- |
| `name`, `vrid`, `vrrp_version`, `interface`, `advert_int` |                |
| `service`           | Name of the service behind the addresses, UI only        |
| `preempt`, `preempt_delay`, `unicast` |                                        |
| `auth_pass_enc`     | *encrypted* VRRPv2 password, never sent to the browser   |
| `virtual_ips`       | JSON `[{ address, prefix, dev? }]`                       |
| `master_node_id`, `master_since` | Current master                              |
| `split_brain_since`, `no_master_since` and their `_notified` flags | Alert state |

**`instance_members`** `(instance_id, node_id)` with `priority`, `interface` override, `initial_state`, and the last
reported `state`, `maintenance` and `holds_vips`.

**`checks`** health checks of a cluster: `key` (id in the config), `params` (JSON), interval, timeout, fall, rise and
weight. **`instance_checks`** links them to VIPs.

**`state_transitions`** every state change of a member, for history and charts.

**`config_rollouts`** and **`config_rollout_nodes`** each apply and its per-node status, output and error.

## Events and delivery

**`events`** type, severity, node, cluster and VIP ids, title, message and template data.

**`channels`** type, *encrypted* `config_enc`, enabled, subscribed events, optional cluster and node filters and
template overrides.

**`deliveries`** one row per event and channel, with status, attempts and the next retry.
**`delivery_attempts`** every send attempt.
