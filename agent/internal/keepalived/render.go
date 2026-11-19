package keepalived

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
)

// Header starts every file KeepWatch writes, so it is recognised and never mistaken for a hand-written config.
const Header = "# Managed by KeepWatch. Changes here are overwritten on the next apply.\n"

// Paths the rendered config refers to.
type Paths struct {
	// Binary is the agent, run by keepalived for health checks.
	Binary string
	// MaintenanceDir holds one track file per instance. A non-zero value puts the instance in FAULT.
	MaintenanceDir string
	// FIFO receives state changes from keepalived.
	FIFO string
}

// Opener opens a sealed value of the command being handled.
type Opener func(sealed string) (string, error)

func scriptName(id string) string  { return "kw_chk_" + id }
func processName(id string) string { return "kw_proc_" + id }
func maintName(name string) string { return "kw_maint_" + name }

// MaintenanceFile is the track file of an instance.
func (p Paths) MaintenanceFile(instance string) string {
	return filepath.Join(p.MaintenanceDir, instance)
}

type writer struct{ b strings.Builder }

func (w *writer) line(indent int, format string, args ...any) {
	w.b.WriteString(strings.Repeat("    ", indent))
	fmt.Fprintf(&w.b, format, args...)
	w.b.WriteString("\n")
}

// Render builds keepwatch.conf from a validated spec. Every value was checked by Validate, and passwords are checked
// again after opening, so nothing can add a directive.
func Render(spec *Spec, paths Paths, open Opener) (string, error) {
	if err := spec.Validate(); err != nil {
		return "", err
	}
	w := &writer{}
	w.b.WriteString(Header)
	w.line(0, "")
	w.line(0, "global_defs {")
	w.line(1, "enable_script_security")
	w.line(1, "script_user root")
	w.line(1, "vrrp_notify_fifo %s", paths.FIFO)
	w.line(0, "}")

	checks := map[string]Check{}
	for _, c := range spec.Checks {
		checks[c.ID] = c
		w.line(0, "")
		if c.Params.Type == "process" {
			w.line(0, "vrrp_track_process %s {", processName(c.ID))
			w.line(1, "process %s", c.Params.Process)
			w.line(1, "quorum 1")
			w.line(1, "delay %d", c.IntervalSec)
			if c.Weight != 0 {
				w.line(1, "weight %d", c.Weight)
			}
			w.line(0, "}")
			continue
		}
		w.line(0, "vrrp_script %s {", scriptName(c.ID))
		w.line(1, `script "%s check %s"`, paths.Binary, c.ID)
		w.line(1, "interval %d", c.IntervalSec)
		w.line(1, "timeout %d", c.TimeoutSec)
		w.line(1, "fall %d", c.Fall)
		w.line(1, "rise %d", c.Rise)
		if c.Weight != 0 {
			w.line(1, "weight %d", c.Weight)
		}
		w.line(0, "}")
	}

	for _, in := range spec.Instances {
		w.line(0, "")
		w.line(0, "vrrp_track_file %s {", maintName(in.Name))
		w.line(1, "file %s", paths.MaintenanceFile(in.Name))
		w.line(1, "weight 0")
		w.line(1, "init_file 0")
		w.line(0, "}")
	}

	for _, in := range spec.Instances {
		w.line(0, "")
		w.line(0, "vrrp_instance %s {", in.Name)
		w.line(1, "state %s", in.State)
		w.line(1, "interface %s", in.Interface)
		w.line(1, "virtual_router_id %d", in.VRID)
		w.line(1, "priority %d", in.Priority)
		w.line(1, "advert_int %d", in.AdvertInt)
		w.line(1, "version %d", in.VRRPVersion)
		if in.Preempt {
			if in.PreemptDelay > 0 {
				w.line(1, "preempt_delay %d", in.PreemptDelay)
			}
		} else {
			w.line(1, "nopreempt")
		}
		if in.UnicastSrcIP != "" {
			w.line(1, "unicast_src_ip %s", in.UnicastSrcIP)
		}
		if len(in.UnicastPeers) > 0 {
			w.line(1, "unicast_peer {")
			for _, peer := range in.UnicastPeers {
				w.line(2, "%s", peer)
			}
			w.line(1, "}")
		}
		if in.AuthPass != "" {
			pass, err := open(in.AuthPass)
			if err != nil {
				return "", fmt.Errorf("%s: %w", in.Name, err)
			}
			if !ValidPassword(pass) {
				return "", fmt.Errorf("%s: the VRRP password has characters that cannot be used", in.Name)
			}
			w.line(1, "authentication {")
			w.line(2, "auth_type PASS")
			w.line(2, "auth_pass %s", pass)
			w.line(1, "}")
		}
		w.line(1, "virtual_ipaddress {")
		for _, vip := range in.VirtualIPs {
			dev := vip.Dev
			if dev == "" {
				dev = in.Interface
			}
			w.line(2, "%s/%d dev %s", vip.Address, vip.Prefix, dev)
		}
		w.line(1, "}")
		if len(in.TrackInterfaces) > 0 {
			w.line(1, "track_interface {")
			for _, t := range in.TrackInterfaces {
				if t.Weight != 0 {
					w.line(2, "%s weight %d", t.Name, t.Weight)
				} else {
					w.line(2, "%s", t.Name)
				}
			}
			w.line(1, "}")
		}
		var scripts, processes []string
		for _, id := range in.Checks {
			if checks[id].Params.Type == "process" {
				processes = append(processes, processName(id))
			} else {
				scripts = append(scripts, scriptName(id))
			}
		}
		block(w, "track_script", scripts)
		block(w, "track_process", processes)
		block(w, "track_file", []string{maintName(in.Name)})
		w.line(0, "}")
	}
	return w.b.String(), nil
}

func block(w *writer, name string, items []string) {
	if len(items) == 0 {
		return
	}
	w.line(1, "%s {", name)
	for _, item := range items {
		w.line(2, "%s", item)
	}
	w.line(1, "}")
}

// Hash identifies a config file's content for drift detection.
func Hash(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}
