// Command keepwatch-agent installs, configures and monitors keepalived on a node for KeepWatch.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/tfourj/KeepWatch/agent/internal/core"
	"github.com/tfourj/KeepWatch/agent/internal/keepalived"
)

var version = "dev"

const (
	stateDir       = "/var/lib/keepwatch-agent"
	binaryPath     = "/usr/local/bin/keepwatch-agent"
	reportInterval = 30 * time.Second
)

// /etc/keepalived may not exist before keepalived is installed, hence the "-" prefix. The agent restarts after
// installing keepalived so it becomes writable. /run/keepwatch holds the notify FIFO and survives agent restarts,
// so keepalived never loses its reader for long.
var unit = fmt.Sprintf(core.UnitTemplate,
	"KeepWatch agent",
	binaryPath,
	"",
	stateDir+" /usr/local/bin -/etc/keepalived",
	"64M",
	"128M",
	"RuntimeDirectory=keepwatch\nRuntimeDirectoryMode=0700\nRuntimeDirectoryPreserve=yes\n",
)

func component() core.Component {
	return core.Component{
		Name:       "keepwatch-agent",
		Version:    version,
		TagPrefix:  "agent-v",
		Manifest:   "agent-release.json",
		StateDir:   stateDir,
		BinaryPath: binaryPath,
		UnitPath:   "/etc/systemd/system/keepwatch-agent.service",
		Unit:       unit,
		Arches:     map[string]string{"amd64": "amd64", "arm64": "arm64", "arm": "armv7"},
	}
}

func dataDir() string {
	if dir := os.Getenv("KEEPWATCH_AGENT_STATE_DIR"); dir != "" {
		return dir
	}
	return stateDir
}

func main() {
	// keepalived runs health checks as `keepwatch-agent check <id>`, outside the agent service.
	if len(os.Args) == 3 && os.Args[1] == "check" {
		sys := keepalived.NewSystem(dataDir(), binaryPath)
		if err := sys.RunCheck(context.Background(), os.Args[2]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	core.Main(component(), "keepalived agent for KeepWatch", func(*core.PersistedState) core.Options {
		sys := keepalived.NewSystem(dataDir(), binaryPath)
		k := &kaAgent{sys: sys, report: make(chan struct{}, 1)}
		return core.Options{
			Handlers: k.handlers(),
			Loops:    []func(context.Context, func(any) error){k.reportLoop},
			Start:    k.follow,
		}
	})
}

type kaAgent struct {
	sys    *keepalived.System
	report chan struct{}
	// exit restarts the agent after keepalived is installed. Tests replace it.
	exit func(int)
}

func (k *kaAgent) reportSoon() {
	select {
	case k.report <- struct{}{}:
	default:
	}
}

// follow reads keepalived's notify FIFO for the life of the process and reports every state change.
func (k *kaAgent) follow(ctx context.Context) {
	go k.sys.Tracker.Follow(ctx, k.sys.Paths.FIFO, log.Printf)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case <-k.sys.Tracker.Changed:
				k.reportSoon()
			}
		}
	}()
}

type statusMessage struct {
	Type   string            `json:"type"`
	Status keepalived.Status `json:"status"`
}

// reportLoop sends the keepalived status when connected, every 30 seconds and after changes.
func (k *kaAgent) reportLoop(ctx context.Context, send func(any) error) {
	ticker := time.NewTicker(reportInterval)
	defer ticker.Stop()
	for {
		checkCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		status := k.sys.Status(checkCtx, keepalived.Addresses())
		cancel()
		if err := send(statusMessage{Type: "ka_status", Status: status}); err != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-k.report:
			// Several changes often arrive together, for example both instances of a failover.
			time.Sleep(200 * time.Millisecond)
		}
	}
}

func toMap(value any) map[string]any {
	data, _ := json.Marshal(value)
	out := map[string]any{}
	_ = json.Unmarshal(data, &out)
	return out
}

func decode(raw json.RawMessage, target any) error {
	if len(raw) == 0 {
		return nil
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(target); err != nil {
		return errors.New("invalid arguments")
	}
	return nil
}

func opener(ctx context.Context) keepalived.Opener {
	return func(sealed string) (string, error) { return core.OpenSealed(ctx, sealed) }
}

func (k *kaAgent) handlers() map[string]core.Handler {
	return map[string]core.Handler{
		"net_info": {Run: func(context.Context, json.RawMessage, *core.Output) (core.Reply, error) {
			return core.Reply{Result: toMap(core.CurrentInfo(version))}, nil
		}},
		"ka_detect": {Run: func(ctx context.Context, _ json.RawMessage, _ *core.Output) (core.Reply, error) {
			return core.Reply{Result: toMap(k.sys.Detect(ctx))}, nil
		}},
		"ka_install": {Async: true, Run: k.install},
		"ka_import": {Run: func(ctx context.Context, raw json.RawMessage, _ *core.Output) (core.Reply, error) {
			var args struct {
				Mode string `json:"mode"`
			}
			if err := decode(raw, &args); err != nil {
				return core.Reply{}, err
			}
			if args.Mode != "" {
				if err := k.sys.SetMode(keepalived.Mode(args.Mode)); err != nil {
					return core.Reply{}, err
				}
				k.reportSoon()
			}
			return core.Reply{Result: toMap(k.sys.Detect(ctx))}, nil
		}},
		"ka_plan": {Run: func(ctx context.Context, raw json.RawMessage, _ *core.Output) (core.Reply, error) {
			var req keepalived.ApplyRequest
			if err := decode(raw, &req); err != nil {
				return core.Reply{}, err
			}
			plan, err := k.sys.PlanApply(req, opener(ctx))
			if err != nil {
				return core.Reply{}, err
			}
			return core.Reply{Result: toMap(plan)}, nil
		}},
		"ka_apply": {Async: true, Run: func(ctx context.Context, raw json.RawMessage, out *core.Output) (core.Reply, error) {
			var req keepalived.ApplyRequest
			if err := decode(raw, &req); err != nil {
				return core.Reply{}, err
			}
			result, err := k.sys.Apply(ctx, req, opener(ctx), out.Line)
			k.reportSoon()
			if err != nil {
				return core.Reply{Result: toMap(result)}, err
			}
			log.Printf("applied keepalived config %s, changed %v", result.Hash[:12], result.Changed)
			return core.Reply{Result: toMap(result)}, nil
		}},
		"ka_service": {Async: true, Run: func(ctx context.Context, raw json.RawMessage, _ *core.Output) (core.Reply, error) {
			var args struct {
				Action string `json:"action"`
			}
			if err := decode(raw, &args); err != nil {
				return core.Reply{}, err
			}
			err := k.sys.Service(ctx, args.Action)
			k.reportSoon()
			if err == nil {
				log.Printf("keepalived %s", args.Action)
			}
			return core.Reply{}, err
		}},
		"ka_maintenance": {Run: func(ctx context.Context, raw json.RawMessage, _ *core.Output) (core.Reply, error) {
			var args struct {
				Instances []string `json:"instances"`
				On        bool     `json:"on"`
			}
			if err := decode(raw, &args); err != nil {
				return core.Reply{}, err
			}
			names, err := k.sys.SetMaintenance(args.Instances, args.On)
			k.reportSoon()
			if err != nil {
				return core.Reply{}, err
			}
			log.Printf("maintenance %v for %s", args.On, strings.Join(names, ", "))
			return core.Reply{Result: map[string]any{"instances": names}}, nil
		}},
		"ka_status": {Run: func(ctx context.Context, _ json.RawMessage, _ *core.Output) (core.Reply, error) {
			return core.Reply{Result: toMap(k.sys.Status(ctx, keepalived.Addresses()))}, nil
		}},
		"ka_logs": {Run: func(ctx context.Context, raw json.RawMessage, _ *core.Output) (core.Reply, error) {
			var args struct {
				Lines int `json:"lines"`
			}
			if err := decode(raw, &args); err != nil {
				return core.Reply{}, err
			}
			lines, err := k.sys.Logs(ctx, args.Lines)
			return core.Reply{Result: map[string]any{"log": lines}}, err
		}},
	}
}

// outsideSandbox runs a package manager command through systemd-run, outside the agent's read-only system.
func outsideSandbox(command []string) (string, []string) {
	if runner, err := exec.LookPath("systemd-run"); err == nil && os.Getuid() == 0 {
		return runner, append([]string{"--wait", "--pipe", "--collect", "--quiet"}, command...)
	}
	return command[0], command[1:]
}

func (k *kaAgent) install(ctx context.Context, _ json.RawMessage, out *core.Output) (core.Reply, error) {
	commands, err := keepalived.InstallCommands(keepalived.PackageManager())
	if err != nil {
		return core.Reply{}, err
	}
	for _, command := range commands {
		out.Line("$ " + strings.Join(command, " "))
		name, args := outsideSandbox(command)
		if err := out.Exec(ctx, name, args...); err != nil {
			return core.Reply{}, fmt.Errorf("%s failed: %w", strings.Join(command, " "), err)
		}
	}
	installed := k.sys.Version(ctx)
	if installed == "" {
		return core.Reply{}, errors.New("keepalived was installed but could not be found")
	}
	out.Line("keepalived " + installed + " installed. Restarting the agent so it can write the config.")
	exit := k.exit
	if exit == nil {
		exit = os.Exit
	}
	return core.Reply{
		Result: map[string]any{"version": installed},
		After: func() {
			time.Sleep(time.Second)
			// Non-zero exit makes systemd restart the agent, which picks up the new config directory.
			exit(75)
		},
	}, nil
}
