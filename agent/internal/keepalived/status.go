package keepalived

import (
	"context"
	"net"
	"net/netip"
	"sort"
	"strings"
)

// InstanceStatus matches instanceStatusSchema in src/shared/keepalived.ts.
type InstanceStatus struct {
	Name        string `json:"name"`
	State       string `json:"state"`
	Priority    *int   `json:"priority"`
	Since       *int64 `json:"since"`
	Maintenance bool   `json:"maintenance"`
}

type Address struct {
	Iface   string `json:"iface"`
	Address string `json:"address"`
	Prefix  int    `json:"prefix"`
}

type CheckStatus struct {
	ID    string `json:"id"`
	OK    bool   `json:"ok"`
	Since *int64 `json:"since"`
	Error string `json:"error,omitempty"`
}

// Status matches kaStatusSchema in src/shared/keepalived.ts.
type Status struct {
	Installed     bool             `json:"installed"`
	Version       *string          `json:"version"`
	Service       string           `json:"service"`
	Enabled       bool             `json:"enabled"`
	Managed       bool             `json:"managed"`
	ConfigHash    *string          `json:"configHash"`
	Drift         bool             `json:"drift"`
	Conflict      *string          `json:"conflict"`
	Instances     []InstanceStatus `json:"instances"`
	Addresses     []Address        `json:"addresses"`
	Checks        []CheckStatus    `json:"checks"`
	CustomScripts bool             `json:"customScripts"`
}

// Addresses lists the addresses on this node's interfaces, without loopback.
func Addresses() []Address {
	out := []Address{}
	ifaces, err := net.Interfaces()
	if err != nil {
		return out
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, a := range addrs {
			if p, err := netip.ParsePrefix(a.String()); err == nil {
				out = append(out, Address{Iface: iface.Name, Address: p.Addr().String(), Prefix: p.Bits()})
			}
			if len(out) >= 256 {
				return out
			}
		}
	}
	return out
}

func ptr[T any](v T) *T { return &v }

// Status builds the report the agent sends every 30 seconds and after changes.
func (s *System) Status(ctx context.Context, addresses []Address) Status {
	version := s.Version(ctx)
	main, _ := readFile(s.MainConf)
	_, _, _, managed := splitBlock(main)
	st := s.loadState()
	status := Status{
		Installed:     version != "",
		Service:       s.unit(ctx, "is-active"),
		Enabled:       s.unit(ctx, "is-enabled") == "enabled",
		Managed:       managed,
		Instances:     []InstanceStatus{},
		Addresses:     addresses,
		Checks:        []CheckStatus{},
		CustomScripts: s.CustomScriptsAllowed(),
	}
	if version != "" {
		status.Version = ptr(version)
	}
	if c := Conflict(main); c != "" {
		status.Conflict = ptr(c)
	}
	if current, err := readFile(s.ManagedPath); err == nil {
		status.ConfigHash = ptr(Hash(current))
		status.Drift = st.Hash != "" && Hash(current) != st.Hash
	} else if st.Hash != "" {
		status.Drift = true
	}

	present := map[string]bool{}
	for _, a := range addresses {
		present[a.Address] = true
	}
	vips := map[string][]VirtualIP{}
	for _, in := range st.Instances {
		vips[in.Name] = in.VirtualIPs
	}
	for _, in := range Import(main) {
		vips[in.Name] = in.VirtualIPs
	}
	known := s.Tracker.Snapshot()
	names := map[string]bool{}
	for name := range vips {
		names[name] = true
	}
	for name := range known {
		names[name] = true
	}
	sorted := make([]string, 0, len(names))
	for name := range names {
		sorted = append(sorted, name)
	}
	sort.Strings(sorted)
	running := status.Service == "active"
	for _, name := range sorted {
		is := InstanceStatus{Name: name, State: "UNKNOWN", Maintenance: s.inMaintenance(name)}
		if k, ok := known[name]; ok && running {
			is.State = k.State
			is.Priority = ptr(k.Priority)
			is.Since = ptr(k.Since.UnixMilli())
		} else if !running {
			is.State = "STOP"
		} else if list := vips[name]; len(list) > 0 {
			// No report since the agent started: holding every VIP means this node is MASTER.
			holds := true
			for _, v := range list {
				holds = holds && present[v.Address]
			}
			if holds {
				is.State = "MASTER"
			} else {
				is.State = "BACKUP"
			}
		}
		status.Instances = append(status.Instances, is)
	}
	for _, c := range st.Checks {
		status.Checks = append(status.Checks, s.checkStatus(ctx, c))
	}
	return status
}

func (s *System) checkStatus(ctx context.Context, c Check) CheckStatus {
	if c.Params.Type == "process" {
		_, err := s.Run(ctx, "pgrep", "-x", c.Params.Process)
		cs := CheckStatus{ID: c.ID, OK: err == nil}
		if err != nil {
			cs.Error = "process " + c.Params.Process + " is not running"
		}
		return cs
	}
	r, ok := s.lastResult(c.ID)
	if !ok {
		return CheckStatus{ID: c.ID, OK: true}
	}
	cs := CheckStatus{ID: c.ID, OK: r.OK, Error: strings.TrimSpace(r.Error)}
	if r.Since > 0 {
		cs.Since = ptr(r.Since)
	}
	return cs
}
