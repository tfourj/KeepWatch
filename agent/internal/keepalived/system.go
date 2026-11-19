package keepalived

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// System runs keepalived tools and reads and writes its files. Tests swap Run and the paths.
type System struct {
	MainConf    string
	ManagedPath string
	StateDir    string
	// AllowScriptsFile exists, root owned, when the agent was installed with --allow-custom-scripts.
	AllowScriptsFile string
	Paths            Paths
	// Run executes a fixed command and returns its combined output.
	Run func(ctx context.Context, name string, args ...string) (string, error)
	Now func() time.Time
	// Verify waits for keepalived to run the new config. Defaults to checking the unit is active.
	Verify  func(ctx context.Context) error
	Tracker *Tracker
}

// NewSystem is the real system.
func NewSystem(stateDir, binary string) *System {
	return &System{
		MainConf:         "/etc/keepalived/keepalived.conf",
		ManagedPath:      "/etc/keepalived/conf.d/keepwatch.conf",
		StateDir:         stateDir,
		AllowScriptsFile: "/etc/keepwatch/allow-custom-scripts",
		Paths: Paths{
			Binary:         binary,
			MaintenanceDir: filepath.Join(stateDir, "maintenance"),
			FIFO:           "/run/keepwatch/notify.fifo",
		},
		Run: func(ctx context.Context, name string, args ...string) (string, error) {
			cmd := exec.CommandContext(ctx, name, args...)
			cmd.Env = append(os.Environ(), "LC_ALL=C")
			out, err := cmd.CombinedOutput()
			return string(out), err
		},
		Now:     time.Now,
		Tracker: NewTracker(),
	}
}

// Mode is how KeepWatch treats this node's config.
type Mode string

const (
	ModeNone    Mode = ""
	ModeManaged Mode = "managed"
	ModeMonitor Mode = "monitor"
)

// localState is ka.json in the state directory.
type localState struct {
	Mode      Mode   `json:"mode"`
	Hash      string `json:"hash,omitempty"`
	AppliedAt int64  `json:"appliedAt,omitempty"`
	// Instances are the managed instances with their VIPs, used to infer states before keepalived reports any.
	Instances []Instance `json:"instances,omitempty"`
	Checks    []Check    `json:"checks,omitempty"`
}

func (s *System) statePath() string { return filepath.Join(s.StateDir, "ka.json") }

func (s *System) loadState() localState {
	var st localState
	if data, err := os.ReadFile(s.statePath()); err == nil {
		_ = json.Unmarshal(data, &st)
	}
	return st
}

func (s *System) saveState(st localState) error {
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(s.statePath(), data, 0o600)
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+".tmp")
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

func readFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	return string(data), err
}

var versionPattern = regexp.MustCompile(`[Kk]eepalived v?(\d+\.\d+(?:\.\d+)?)`)

// Version is the installed keepalived version, or "" when it is not installed.
func (s *System) Version(ctx context.Context) string {
	out, _ := s.Run(ctx, "keepalived", "--version")
	if m := versionPattern.FindStringSubmatch(out); m != nil {
		return m[1]
	}
	return ""
}

// supportsConfigTest reports whether keepalived can check a config without running it (2.0.11 and later).
func supportsConfigTest(version string) bool {
	parts := strings.Split(version, ".")
	nums := make([]int, 3)
	for i := 0; i < len(parts) && i < 3; i++ {
		nums[i], _ = strconv.Atoi(parts[i])
	}
	if nums[0] != 2 {
		return nums[0] > 2
	}
	return nums[1] > 0 || nums[2] >= 11
}

func (s *System) unit(ctx context.Context, verb string) string {
	out, _ := s.Run(ctx, "systemctl", verb, "keepalived")
	return strings.TrimSpace(strings.Split(strings.TrimSpace(out), "\n")[0])
}

// PackageManager is apt, dnf or pacman, or empty when none is found.
func PackageManager() string {
	for _, pm := range []string{"apt-get", "dnf", "pacman"} {
		if _, err := exec.LookPath(pm); err == nil {
			return strings.TrimSuffix(pm, "-get")
		}
	}
	return ""
}

// InstallCommands install keepalived and create its config directory. They run outside the agent's sandbox.
func InstallCommands(pm string) ([][]string, error) {
	mkdir := []string{"mkdir", "-p", "/etc/keepalived/conf.d"}
	switch pm {
	case "apt":
		return [][]string{{"apt-get", "update"}, {"apt-get", "install", "-y", "keepalived"}, mkdir}, nil
	case "dnf":
		return [][]string{{"dnf", "install", "-y", "keepalived"}, mkdir}, nil
	case "pacman":
		return [][]string{{"pacman", "-Sy", "--noconfirm", "--needed", "keepalived"}, mkdir}, nil
	}
	return nil, errors.New("no supported package manager (apt, dnf or pacman) found; install keepalived by hand")
}

// Detected describes the node for the setup wizard.
type Detected struct {
	Installed      bool       `json:"installed"`
	Version        string     `json:"version"`
	ConfigTest     bool       `json:"configTest"`
	PackageManager string     `json:"packageManager"`
	Service        string     `json:"service"`
	Mode           Mode       `json:"mode"`
	Managed        bool       `json:"managed"`
	Existing       []Imported `json:"existing"`
	Conflict       string     `json:"conflict"`
	CustomScripts  bool       `json:"customScripts"`
}

func (s *System) Detect(ctx context.Context) Detected {
	version := s.Version(ctx)
	main, _ := readFile(s.MainConf)
	_, _, _, managed := splitBlock(main)
	return Detected{
		Installed:      version != "",
		Version:        version,
		ConfigTest:     supportsConfigTest(version),
		PackageManager: PackageManager(),
		Service:        s.unit(ctx, "is-active"),
		Mode:           s.loadState().Mode,
		Managed:        managed,
		Existing:       Import(main),
		Conflict:       Conflict(main),
		CustomScripts:  s.CustomScriptsAllowed(),
	}
}

// CustomScriptsAllowed reports whether the installer turned on custom check scripts.
func (s *System) CustomScriptsAllowed() bool {
	return rootOwnedNotWritable(s.AllowScriptsFile) == nil
}

func rootOwnedNotWritable(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s is a symlink", path)
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || st.Uid != 0 {
		return fmt.Errorf("%s must be owned by root", path)
	}
	if info.Mode().Perm()&0o022 != 0 {
		return fmt.Errorf("%s must not be writable by group or others", path)
	}
	return nil
}

// SetMode records whether KeepWatch manages this node's config or only monitors it.
func (s *System) SetMode(mode Mode) error {
	if mode != ModeManaged && mode != ModeMonitor {
		return errors.New("mode must be managed or monitor")
	}
	st := s.loadState()
	st.Mode = mode
	return s.saveState(st)
}

// Plan is what an apply would change, shown to the user before anything is written.
type Plan struct {
	Current      string   `json:"current"`
	Next         string   `json:"next"`
	MainCurrent  string   `json:"mainCurrent"`
	MainNext     string   `json:"mainNext"`
	Changed      bool     `json:"changed"`
	Hash         string   `json:"hash"`
	Instances    []string `json:"instances"`
	MigratedFrom []string `json:"migratedFrom"`
}

// ApplyRequest is the body of ka_plan and ka_apply.
type ApplyRequest struct {
	Spec json.RawMessage `json:"spec"`
	// Migrate names existing vrrp_instance blocks to comment out, for the migrate flow.
	Migrate []string `json:"migrate"`
}

func (s *System) plan(req ApplyRequest, open Opener) (*Plan, *Spec, error) {
	spec, err := ParseSpec(req.Spec)
	if err != nil {
		return nil, nil, err
	}
	for _, c := range spec.Checks {
		if c.Params.Type == "script" && !s.CustomScriptsAllowed() {
			return nil, nil, errors.New("custom scripts are off on this node; reinstall the agent with --allow-custom-scripts")
		}
	}
	if s.loadState().Mode == ModeMonitor {
		return nil, nil, errors.New("this node is monitored only; KeepWatch does not write its config")
	}
	next, err := Render(spec, s.Paths, open)
	if err != nil {
		return nil, nil, err
	}
	current, _ := readFile(s.ManagedPath)
	main, err := readFile(s.MainConf)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, nil, err
	}
	if conflict := Conflict(main); conflict != "" {
		return nil, nil, errors.New(conflict)
	}
	migrate := map[string]bool{}
	for _, name := range req.Migrate {
		if !nameRe.MatchString(name) {
			return nil, nil, fmt.Errorf("invalid instance name %q", name)
		}
		migrate[name] = true
	}
	mainNext := withInclude(CommentOut(main, migrate), s.ManagedPath)
	names := make([]string, 0, len(spec.Instances))
	for _, in := range spec.Instances {
		names = append(names, in.Name)
	}
	// Instance names must not clash with ones keepalived.conf still defines.
	for _, existing := range Import(mainNext) {
		for _, name := range names {
			if existing.Name == name {
				return nil, nil, fmt.Errorf("keepalived.conf already defines %s; migrate it or rename the VIP", name)
			}
		}
	}
	return &Plan{
		Current:      current,
		Next:         next,
		MainCurrent:  main,
		MainNext:     mainNext,
		Changed:      current != next || main != mainNext,
		Hash:         Hash(next),
		Instances:    names,
		MigratedFrom: req.Migrate,
	}, spec, nil
}

// PlanApply renders the config and returns the change without writing anything.
func (s *System) PlanApply(req ApplyRequest, open Opener) (*Plan, error) {
	plan, _, err := s.plan(req, open)
	if plan != nil {
		// Passwords stay on the node: they are opened only to render the file.
		plan.Current = maskPasswords(plan.Current)
		plan.Next = maskPasswords(plan.Next)
	}
	return plan, err
}

var passLine = regexp.MustCompile(`(?m)^(\s*auth_pass\s+)\S+`)

func maskPasswords(text string) string { return passLine.ReplaceAllString(text, "${1}********") }

// Line receives progress output.
type Line func(string)

// ApplyResult is the answer to ka_apply.
type ApplyResult struct {
	Changed    bool   `json:"changed"`
	Hash       string `json:"hash"`
	RolledBack bool   `json:"rolledBack"`
	Backup     string `json:"backup,omitempty"`
}

const keepBackups = 10

// Apply writes the config after keepalived accepted it, reloads, verifies and rolls back on failure.
func (s *System) Apply(ctx context.Context, req ApplyRequest, open Opener, say Line) (ApplyResult, error) {
	plan, spec, err := s.plan(req, open)
	if err != nil {
		return ApplyResult{}, err
	}
	st := s.loadState()
	if !plan.Changed && st.Hash == plan.Hash {
		say("Config is already up to date")
		return ApplyResult{Changed: false, Hash: plan.Hash}, nil
	}
	version := s.Version(ctx)
	if version == "" {
		return ApplyResult{}, errors.New("keepalived is not installed")
	}
	if !supportsConfigTest(version) {
		return ApplyResult{}, fmt.Errorf("keepalived %s cannot test a config before using it; 2.0.11 or newer is needed", version)
	}

	// keepalived checks that tracked files exist, also when it only tests a config, so they come first. They only
	// hold 0 until maintenance is turned on, and a config that does not use them ignores them.
	if err := s.prepareTrackFiles(spec); err != nil {
		return ApplyResult{}, err
	}
	say("Testing the new config with keepalived")
	if err := s.configTest(ctx, plan); err != nil {
		return ApplyResult{}, err
	}

	stamp := s.Now().UTC().Format("20060102-150405")
	backup := ""
	if plan.Current != "" {
		backup = s.ManagedPath + ".keepwatch-" + stamp
		if err := writeAtomic(backup, []byte(plan.Current), 0o600); err != nil {
			return ApplyResult{}, fmt.Errorf("backup failed: %w", err)
		}
		s.pruneBackups(filepath.Base(s.ManagedPath))
	}
	if plan.MainCurrent != plan.MainNext && plan.MainCurrent != "" {
		mainBackup := s.MainConf + ".keepwatch-" + stamp
		if err := writeAtomic(mainBackup, []byte(plan.MainCurrent), 0o600); err != nil {
			return ApplyResult{}, fmt.Errorf("backup failed: %w", err)
		}
		s.pruneBackups(filepath.Base(s.MainConf))
	}

	if err := s.writeChecks(spec); err != nil {
		return ApplyResult{}, err
	}
	say("Writing " + s.ManagedPath)
	if err := writeAtomic(s.ManagedPath, []byte(plan.Next), 0o600); err != nil {
		return ApplyResult{}, err
	}
	if plan.MainCurrent != plan.MainNext {
		say("Updating " + s.MainConf)
		if err := writeAtomic(s.MainConf, []byte(plan.MainNext), 0o644); err != nil {
			s.restore(plan)
			return ApplyResult{}, err
		}
	}

	say("Reloading keepalived")
	if err := s.reloadAndVerify(ctx); err != nil {
		say("keepalived did not come up with the new config, restoring the previous one")
		s.restore(plan)
		if rerr := s.reloadAndVerify(ctx); rerr != nil {
			say("keepalived is not running after the rollback either: " + rerr.Error())
		}
		return ApplyResult{RolledBack: true, Backup: backup}, fmt.Errorf("rolled back: %w", err)
	}

	st.Hash = plan.Hash
	st.AppliedAt = s.Now().UnixMilli()
	st.Instances = spec.Instances
	st.Checks = spec.Checks
	if st.Mode == ModeNone {
		st.Mode = ModeManaged
	}
	if err := s.saveState(st); err != nil {
		return ApplyResult{}, err
	}
	say("Applied")
	return ApplyResult{Changed: true, Hash: plan.Hash, Backup: backup}, nil
}

// configTest writes the candidate files next to the real ones and lets keepalived check them.
func (s *System) configTest(ctx context.Context, plan *Plan) error {
	dir := filepath.Dir(s.MainConf)
	candidate := filepath.Join(filepath.Dir(s.ManagedPath), ".keepwatch-test.conf")
	mainCandidate := filepath.Join(dir, ".keepwatch-test-main.conf")
	defer os.Remove(candidate)
	defer os.Remove(mainCandidate)
	if err := writeAtomic(candidate, []byte(plan.Next), 0o600); err != nil {
		return err
	}
	main := strings.Replace(plan.MainNext, "include "+s.ManagedPath, "include "+candidate, 1)
	if err := writeAtomic(mainCandidate, []byte(main), 0o600); err != nil {
		return err
	}
	out, err := s.Run(ctx, "keepalived", "--config-test", "-f", mainCandidate)
	if err != nil {
		return fmt.Errorf("keepalived rejected the config: %s", truncate(strings.TrimSpace(out), 800))
	}
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// prepareTrackFiles creates the maintenance files and the notify FIFO the new config refers to. Existing
// maintenance files keep their value.
func (s *System) prepareTrackFiles(spec *Spec) error {
	if err := os.MkdirAll(s.Paths.MaintenanceDir, 0o700); err != nil {
		return err
	}
	for _, in := range spec.Instances {
		path := s.Paths.MaintenanceFile(in.Name)
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			if err := writeAtomic(path, []byte("0\n"), 0o600); err != nil {
				return err
			}
		}
	}
	return EnsureFIFO(s.Paths.FIFO)
}

// writeChecks saves the check definitions `keepwatch-agent check <id>` runs. Only after the config passed its test,
// since the running config uses the same file.
func (s *System) writeChecks(spec *Spec) error {
	data, err := json.MarshalIndent(spec.Checks, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(s.checksPath(), data, 0o600)
}

// EnsureFIFO creates the notify FIFO keepalived writes state changes to.
func EnsureFIFO(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&os.ModeNamedPipe != 0 {
			return nil
		}
		if err := os.Remove(path); err != nil {
			return err
		}
	}
	return syscall.Mkfifo(path, 0o600)
}

func (s *System) restore(plan *Plan) {
	if plan.Current == "" {
		os.Remove(s.ManagedPath)
	} else {
		_ = writeAtomic(s.ManagedPath, []byte(plan.Current), 0o600)
	}
	if plan.MainCurrent == "" {
		os.Remove(s.MainConf)
	} else if plan.MainCurrent != plan.MainNext {
		_ = writeAtomic(s.MainConf, []byte(plan.MainCurrent), 0o644)
	}
}

func (s *System) reloadAndVerify(ctx context.Context) error {
	verb := "reload"
	if s.unit(ctx, "is-active") != "active" {
		verb = "restart"
	}
	if out, err := s.Run(ctx, "systemctl", verb, "keepalived"); err != nil {
		return fmt.Errorf("systemctl %s keepalived: %s", verb, truncate(strings.TrimSpace(out), 300))
	}
	if s.Verify != nil {
		return s.Verify(ctx)
	}
	deadline := s.Now().Add(10 * time.Second)
	for {
		if state := s.unit(ctx, "is-active"); state == "active" {
			return nil
		} else if state == "failed" || s.Now().After(deadline) {
			return fmt.Errorf("keepalived is %s", state)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func (s *System) pruneBackups(base string) {
	dir := filepath.Dir(s.ManagedPath)
	if base == filepath.Base(s.MainConf) {
		dir = filepath.Dir(s.MainConf)
	}
	matches, _ := filepath.Glob(filepath.Join(dir, base+".keepwatch-*"))
	sort.Strings(matches)
	for len(matches) > keepBackups {
		os.Remove(matches[0])
		matches = matches[1:]
	}
}

// Service runs a systemctl action on keepalived.
func (s *System) Service(ctx context.Context, action string) error {
	switch action {
	case "start", "stop", "restart", "reload", "enable", "disable":
	default:
		return fmt.Errorf("unknown action %q", action)
	}
	out, err := s.Run(ctx, "systemctl", action, "keepalived")
	if err != nil {
		return fmt.Errorf("systemctl %s keepalived: %s", action, truncate(strings.TrimSpace(out), 300))
	}
	return nil
}

// Logs returns the last lines of keepalived's journal.
func (s *System) Logs(ctx context.Context, lines int) (string, error) {
	if lines <= 0 || lines > 500 {
		lines = 200
	}
	out, err := s.Run(ctx, "journalctl", "-u", "keepalived", "-n", strconv.Itoa(lines), "--no-pager", "-o", "short-iso")
	if err != nil {
		return "", fmt.Errorf("journalctl failed: %s", truncate(strings.TrimSpace(out), 300))
	}
	return out, nil
}

// SetMaintenance turns maintenance on or off for the given instances, or all managed ones when names is empty.
func (s *System) SetMaintenance(names []string, on bool) ([]string, error) {
	st := s.loadState()
	known := map[string]bool{}
	for _, in := range st.Instances {
		known[in.Name] = true
	}
	if len(names) == 0 {
		for name := range known {
			names = append(names, name)
		}
		sort.Strings(names)
	}
	value := "0\n"
	if on {
		value = "1\n"
	}
	for _, name := range names {
		if !known[name] {
			return nil, fmt.Errorf("%s is not managed by KeepWatch on this node", name)
		}
		if err := writeAtomic(s.Paths.MaintenanceFile(name), []byte(value), 0o600); err != nil {
			return nil, err
		}
	}
	return names, nil
}

func (s *System) inMaintenance(name string) bool {
	data, err := os.ReadFile(s.Paths.MaintenanceFile(name))
	return err == nil && strings.TrimSpace(string(data)) != "0" && strings.TrimSpace(string(data)) != ""
}
