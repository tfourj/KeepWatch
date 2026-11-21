# Configuration

## Setup

1. Open `BASE_URL` and create your account. It is the only account; registration closes afterwards.
2. In **Clusters**, add a cluster for each group of machines that share virtual IPs.
3. In **Nodes**, add each keepalived machine to its cluster, or create the cluster there, and run the install command
   on it (see [Agents](#agents)).
4. In the setup step, choose **Manage with KeepWatch**, **Import into KeepWatch** for an existing config, or
   **Monitor only**.
5. In **Clusters**, add a VIP, pick its members and priorities, then press **Apply**.
6. In **Channels**, add a channel and press **Test**.

## Environment variables

| Variable             | Default                 | Description                                                    |
| -------------------- | ----------------------- | -------------------------------------------------------------- |
| `PORT`               | `4321`                  | Port the app listens on                                        |
| `BASE_URL`           | `http://localhost:PORT` | Public URL, used for login cookies and agent install commands  |
| `BETTER_AUTH_SECRET` | generated               | Session signing secret, at least 32 characters                 |
| `ENCRYPTION_SECRET`  | generated               | Key for encrypting VRRP passwords and channel credentials      |
| `TZ`                 | `UTC`                   | Default timezone for `{time}` in notifications                 |
| `LOG_LEVEL`          | `info`                  | `debug`, `info`, `warn` or `error`                             |
| `LOG_BUFFER_SIZE`    | `1000`                  | Recent log lines kept in memory for the **Logs** page          |

Missing secrets are generated into `/data/secrets.json`. All data lives in the `/data` volume; back it up as a whole.
Without the encryption secret, stored credentials cannot be decrypted and agents must be paired again.

## Agents

The agent runs on Linux with systemd (amd64, arm64 or armv7). It connects out to `BASE_URL`, so the node needs no
open port. Run the command from **Install agent** as root:

```bash
curl -fsSL https://raw.githubusercontent.com/tfourj/KeepWatch/main/agent/install.sh | sh -s -- --server https://keepwatch.example.com --token <token>
```

On Proxmox you are already root. Elsewhere use `| sudo sh -s -- ...`. The token works once and expires after 15
minutes. Add `--allow-custom-scripts` to let health checks run your own scripts (see [Health checks](#health-checks)).

The agent only accepts signed commands from your KeepWatch server and never runs a shell command, path or URL sent
by it. VRRP passwords are encrypted to each node's own key, so a proxy in front of KeepWatch never sees them. New
agents update automatically when a release comes out (turn off **Automatic updates** in the node menu to opt out).

```bash
keepwatch-agent status              # pairing and version
journalctl -u keepwatch-agent -f    # logs
curl -fsSL https://raw.githubusercontent.com/tfourj/KeepWatch/main/agent/uninstall.sh | sh    # remove, keepalived stays
```

If you unpair an offline agent, run `keepwatch-agent reset --confirm` on the node before pairing it again.

## keepalived

The setup step checks keepalived on the node. If it is missing, **Install keepalived** installs it with apt, dnf or
pacman. Managing the config needs keepalived 2.0.11 or newer, so each change can be tested first.

- **Manage with KeepWatch:** KeepWatch writes `/etc/keepalived/conf.d/keepwatch.conf` and adds one `include` line
  between `# BEGIN keepwatch` and `# END keepwatch` in `keepalived.conf`. Nothing else in that file changes.
- **Import into KeepWatch:** the `vrrp_instance` blocks in `keepalived.conf` become VIPs in the node's cluster.
  Settings KeepWatch does not manage, like `notify_master`, are listed before you import. VRRP passwords are never
  read from the node; enter them again. The next apply comments the original blocks out with `# keepwatch-migrated:`.
- **Monitor only:** KeepWatch never writes the config and shows the states keepalived reports.

**Apply** shows the change for each node, then applies it to backups first and the current master last. Each node
tests the new config with `keepalived --config-test`, keeps a `.keepwatch-<time>` backup (the last 10), reloads
keepalived and restores the backup if keepalived does not come up. A failed node stops the rollout.

A node whose config is behind shows **Changes not applied** or **Import pending** with an **Apply** button that opens
its cluster's preview.

If `keepwatch.conf` is edited by hand, the node shows **Edited outside KeepWatch** and the next apply replaces it.

## VIPs

Each VIP is one VRRP instance: its addresses, VRID, interface and members with a priority each. Give it the name of
the service behind it, for example **AdGuard Home** on three nodes, and it is shown by that name everywhere. The member with the
highest priority holds the addresses. With **Unicast** on, members send adverts to each other's addresses on the
interface instead of multicast. IPv6 addresses need VRRP version 3; passwords exist only in version 2.

VRRP is IP protocol 112. Allow it between the members in your firewall, and multicast to `224.0.0.18` when unicast
is off.

**Fail over** in a VIP menu puts the current master into maintenance for that VIP, so a backup takes over. It stays
there until you choose **End maintenance**. **Maintenance** in a node menu does the same for every VIP on that node.

## Services

**Services** shows each VIP as a live diagram: clients reach the address, which points at the node that holds it.
The active path is animated, standby nodes are dashed, and nodes in FAULT, maintenance or offline are marked. A node
that takes over flashes. The view updates every 2 seconds and shows where keepalived put the address, not measured
traffic.

## Health checks

Health checks belong to a cluster and are picked per VIP. **Start from** fills in a check for a common service,
such as AdGuard Home, Pi-hole, nginx, HAProxy or PostgreSQL:

| Type          | Checks                                                       |
| ------------- | ------------------------------------------------------------ |
| TCP port      | A connection to a host and port                              |
| HTTP(S)       | A GET request returns the expected status                    |
| Ping          | A host answers one ping                                      |
| Process       | A process is running (keepalived's `track_process`)          |
| Custom script | A script in `/etc/keepwatch/scripts` exits with 0            |

A failing check lowers the node's priority by its weight, or puts the VIP in FAULT on that node with weight 0.
Custom scripts only run on nodes installed with `--allow-custom-scripts`, and must be owned by root and not writable
by anyone else.

## Notifications

Templates are set in **Settings → Templates** and can be overridden per channel. Variables:

`{event}` `{title}` `{message}` `{cluster}` `{vip}` `{address}` `{node}` `{from}` `{to}` `{state}` `{priority}`
`{check}` `{reason}` `{count}` `{version}` `{error}` `{duration}` `{time}`

The preset menu fills every template at once: Default, Minimalistic, Detailed, Simplified, and an icon version of
each. Simplified sends a short title and one line, with changes shown as `lb1 → lb2`.

**Preview** shows a template filled in with an example event. A line whose variables are all empty for an event is
left out. Channels can be limited to some clusters or nodes.

**Split brain** is sent when more than one node holds a VIP, and **No master** when none does, once it lasted three
advert intervals plus the extra delay in **Settings → General**. Repeated failovers of one VIP within the window set
there are sent as one message.

Failed deliveries are retried up to 6 times. Each attempt is shown in **Events**, where you can also retry by hand.

## Account security

**Settings → Security** has three options:

- **Two-factor authentication:** scan the QR code with an authenticator app and enter a code to turn it on. Save the
  10 backup codes it shows; each works once. Sign-ins then ask for a code, and **Trust this device** skips it for 30
  days.
- **Login notifications:** pick the channels that get a message for every sign-in, with the method, device and IP
  address.
- **Devices:** lists every signed-in device. Tick devices and use **Sign out selected**, or **Sign out all**.

## Reverse proxy, Coolify and Cloudflare

- Set `BASE_URL` to the public HTTPS URL. API requests from any other origin are refused.
- **Coolify:** deploy `docker-compose.yml`, set the domain and env vars, and keep `/data` on a persistent volume.
- **Cloudflare:** agents can be blocked as bots. Disable **Bot Fight Mode**, or add a WAF custom rule that skips
  security features for `starts_with(http.request.uri.path, "/api/agents/")`.

## Reset password

```bash
docker exec -it keepwatch bun src/server/cli.ts reset-password 'new-password'
```

If you lose your authenticator app and backup codes, turn off two-factor authentication:

```bash
docker exec -it keepwatch bun src/server/cli.ts disable-2fa
```
