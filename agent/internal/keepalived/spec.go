// Package keepalived renders, applies and monitors the keepalived config KeepWatch manages on a node.
package keepalived

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
)

// SpecVersion matches SPEC_VERSION in src/shared/keepalived.ts. Keep both files in sync.
const SpecVersion = 1

var (
	nameRe     = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$`)
	ifaceRe    = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.:@-]{0,14}$`)
	processRe  = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,63}$`)
	checkIDRe  = regexp.MustCompile(`^[a-z0-9_]{1,32}$`)
	hostnameRe = regexp.MustCompile(`^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$`)
	scriptRe   = regexp.MustCompile(`^/etc/keepwatch/scripts/[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$`)
	// VRRPv2 simple passwords: printable ASCII without spaces, quotes, braces, backslashes or comment marks.
	passRe = regexp.MustCompile(`^[A-Za-z0-9$%&()*+,\-./:;<=>?@\[\]^_|~]{1,8}$`)
)

// ScriptDir holds custom check scripts. They must be owned by root and not writable by others.
const ScriptDir = "/etc/keepwatch/scripts"

// Spec is what the server sends with ka_plan and ka_apply.
type Spec struct {
	Version   int        `json:"version"`
	Instances []Instance `json:"instances"`
	Checks    []Check    `json:"checks"`
}

type VirtualIP struct {
	Address string `json:"address"`
	Prefix  int    `json:"prefix"`
	Dev     string `json:"dev,omitempty"`
}

type TrackInterface struct {
	Name   string `json:"name"`
	Weight int    `json:"weight"`
}

type Instance struct {
	Name            string           `json:"name"`
	VRID            int              `json:"vrid"`
	VRRPVersion     int              `json:"vrrpVersion"`
	Interface       string           `json:"interface"`
	State           string           `json:"state"`
	Priority        int              `json:"priority"`
	AdvertInt       int              `json:"advertInt"`
	Preempt         bool             `json:"preempt"`
	PreemptDelay    int              `json:"preemptDelay"`
	UnicastSrcIP    string           `json:"unicastSrcIp,omitempty"`
	UnicastPeers    []string         `json:"unicastPeers"`
	VirtualIPs      []VirtualIP      `json:"virtualIps"`
	AuthPass        string           `json:"authPass,omitempty"`
	TrackInterfaces []TrackInterface `json:"trackInterfaces"`
	Checks          []string         `json:"checks"`
}

// CheckParams is one of the check types; Type says which fields are set.
type CheckParams struct {
	Type         string `json:"type"`
	Host         string `json:"host,omitempty"`
	Port         int    `json:"port,omitempty"`
	URL          string `json:"url,omitempty"`
	ExpectStatus int    `json:"expectStatus,omitempty"`
	InsecureTLS  bool   `json:"insecureTls,omitempty"`
	Process      string `json:"process,omitempty"`
	Path         string `json:"path,omitempty"`
}

type Check struct {
	ID          string      `json:"id"`
	Params      CheckParams `json:"params"`
	IntervalSec int         `json:"intervalSec"`
	TimeoutSec  int         `json:"timeoutSec"`
	Fall        int         `json:"fall"`
	Rise        int         `json:"rise"`
	Weight      int         `json:"weight"`
}

// ParseSpec decodes and validates a spec. Unknown fields are rejected.
func ParseSpec(raw json.RawMessage) (*Spec, error) {
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	var spec Spec
	if err := dec.Decode(&spec); err != nil {
		return nil, fmt.Errorf("invalid spec: %w", err)
	}
	if err := spec.Validate(); err != nil {
		return nil, err
	}
	return &spec, nil
}

func inRange(v, lo, hi int) bool { return v >= lo && v <= hi }

func parseIP(value string) (netip.Addr, error) {
	addr, err := netip.ParseAddr(value)
	if err != nil || addr.Zone() != "" {
		return netip.Addr{}, fmt.Errorf("invalid address %q", value)
	}
	return addr, nil
}

func validHost(value string) bool {
	if _, err := parseIP(value); err == nil {
		return true
	}
	return len(value) <= 253 && hostnameRe.MatchString(value)
}

func (c Check) validate() error {
	if !checkIDRe.MatchString(c.ID) {
		return fmt.Errorf("invalid check id %q", c.ID)
	}
	if !inRange(c.IntervalSec, 1, 3600) || !inRange(c.TimeoutSec, 1, 60) || !inRange(c.Fall, 1, 10) ||
		!inRange(c.Rise, 1, 10) || !inRange(c.Weight, -254, 254) {
		return fmt.Errorf("check %s: value out of range", c.ID)
	}
	p := c.Params
	switch p.Type {
	case "tcp":
		if !validHost(p.Host) || !inRange(p.Port, 1, 65535) {
			return fmt.Errorf("check %s: invalid host or port", c.ID)
		}
	case "ping":
		if !validHost(p.Host) {
			return fmt.Errorf("check %s: invalid host", c.ID)
		}
	case "http":
		u, err := url.Parse(p.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || len(p.URL) > 300 ||
			strings.ContainsAny(p.URL, " \t\r\n\"'\\") || !inRange(p.ExpectStatus, 100, 599) {
			return fmt.Errorf("check %s: invalid URL", c.ID)
		}
	case "process":
		if !processRe.MatchString(p.Process) {
			return fmt.Errorf("check %s: invalid process name", c.ID)
		}
	case "script":
		if !scriptRe.MatchString(p.Path) || strings.Contains(p.Path, "..") {
			return fmt.Errorf("check %s: scripts must be in %s", c.ID, ScriptDir)
		}
	default:
		return fmt.Errorf("check %s: unknown type %q", c.ID, p.Type)
	}
	return nil
}

func (in Instance) validate(checks map[string]bool) error {
	if !nameRe.MatchString(in.Name) {
		return fmt.Errorf("invalid instance name %q", in.Name)
	}
	if !ifaceRe.MatchString(in.Interface) {
		return fmt.Errorf("%s: invalid interface %q", in.Name, in.Interface)
	}
	if !inRange(in.VRID, 1, 255) || !inRange(in.Priority, 1, 254) || !inRange(in.AdvertInt, 1, 255) ||
		!inRange(in.PreemptDelay, 0, 1000) {
		return fmt.Errorf("%s: value out of range", in.Name)
	}
	if in.VRRPVersion != 2 && in.VRRPVersion != 3 {
		return fmt.Errorf("%s: VRRP version must be 2 or 3", in.Name)
	}
	if in.State != "MASTER" && in.State != "BACKUP" {
		return fmt.Errorf("%s: state must be MASTER or BACKUP", in.Name)
	}
	if !in.Preempt && in.State != "BACKUP" {
		return fmt.Errorf("%s: no preempt needs the BACKUP state", in.Name)
	}
	if len(in.VirtualIPs) == 0 || len(in.VirtualIPs) > 20 || len(in.UnicastPeers) > 16 ||
		len(in.TrackInterfaces) > 8 || len(in.Checks) > 16 {
		return fmt.Errorf("%s: too many or too few entries", in.Name)
	}
	v6 := 0
	for _, vip := range in.VirtualIPs {
		addr, err := parseIP(vip.Address)
		if err != nil {
			return fmt.Errorf("%s: %w", in.Name, err)
		}
		max := 32
		if addr.Is6() {
			max = 128
			v6++
		}
		if !inRange(vip.Prefix, 0, max) {
			return fmt.Errorf("%s: prefix out of range for %s", in.Name, vip.Address)
		}
		if vip.Dev != "" && !ifaceRe.MatchString(vip.Dev) {
			return fmt.Errorf("%s: invalid interface %q", in.Name, vip.Dev)
		}
	}
	if v6 > 0 && in.VRRPVersion != 3 {
		return fmt.Errorf("%s: IPv6 addresses need VRRP version 3", in.Name)
	}
	if v6 > 0 && v6 != len(in.VirtualIPs) {
		return fmt.Errorf("%s: do not mix IPv4 and IPv6 addresses", in.Name)
	}
	if in.UnicastSrcIP != "" {
		if _, err := parseIP(in.UnicastSrcIP); err != nil {
			return fmt.Errorf("%s: %w", in.Name, err)
		}
	}
	for _, peer := range in.UnicastPeers {
		if _, err := parseIP(peer); err != nil {
			return fmt.Errorf("%s: %w", in.Name, err)
		}
		if peer == in.UnicastSrcIP {
			return fmt.Errorf("%s: the source address cannot be its own peer", in.Name)
		}
	}
	if in.AuthPass != "" {
		if in.VRRPVersion != 2 {
			return fmt.Errorf("%s: passwords only exist in VRRP version 2", in.Name)
		}
		if !strings.HasPrefix(in.AuthPass, "s1:") {
			return fmt.Errorf("%s: password must be sealed", in.Name)
		}
	}
	for _, t := range in.TrackInterfaces {
		if !ifaceRe.MatchString(t.Name) || !inRange(t.Weight, -254, 254) {
			return fmt.Errorf("%s: invalid tracked interface", in.Name)
		}
	}
	for _, id := range in.Checks {
		if !checks[id] {
			return fmt.Errorf("%s: unknown check %s", in.Name, id)
		}
	}
	return nil
}

// Validate applies the same rules as specProblems on the server, so a server bug cannot reach the config.
func (s *Spec) Validate() error {
	if s.Version != SpecVersion {
		return fmt.Errorf("unsupported spec version %d", s.Version)
	}
	if len(s.Instances) > 64 || len(s.Checks) > 64 {
		return errors.New("spec is too large")
	}
	checks := map[string]bool{}
	for _, c := range s.Checks {
		if err := c.validate(); err != nil {
			return err
		}
		if checks[c.ID] {
			return errors.New("check ids must be unique")
		}
		checks[c.ID] = true
	}
	names := map[string]bool{}
	vrids := map[string]bool{}
	for _, in := range s.Instances {
		if err := in.validate(checks); err != nil {
			return err
		}
		if names[in.Name] {
			return fmt.Errorf("instance name %s is used twice", in.Name)
		}
		names[in.Name] = true
		family := 4
		if addr, _ := parseIP(in.VirtualIPs[0].Address); addr.Is6() {
			family = 6
		}
		key := fmt.Sprintf("%s/%d/%d", in.Interface, in.VRID, family)
		if vrids[key] {
			return fmt.Errorf("VRID %d is used twice on %s", in.VRID, in.Interface)
		}
		vrids[key] = true
	}
	return nil
}

// ValidPassword reports whether an opened VRRP password can be written to the config.
func ValidPassword(pass string) bool { return passRe.MatchString(pass) }
