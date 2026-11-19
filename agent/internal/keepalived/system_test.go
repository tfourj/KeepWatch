package keepalived

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeRun struct {
	calls      []string
	testFails  bool
	verifyErrs []error
}

func testSystem(t *testing.T, f *fakeRun) *System {
	t.Helper()
	dir := t.TempDir()
	s := NewSystem(filepath.Join(dir, "state"), "/usr/local/bin/keepwatch-agent")
	s.MainConf = filepath.Join(dir, "etc", "keepalived.conf")
	s.ManagedPath = filepath.Join(dir, "etc", "conf.d", "keepwatch.conf")
	s.AllowScriptsFile = filepath.Join(dir, "allow")
	s.Paths.FIFO = filepath.Join(dir, "run", "notify.fifo")
	s.Paths.MaintenanceDir = filepath.Join(dir, "state", "maintenance")
	s.Run = func(_ context.Context, name string, args ...string) (string, error) {
		call := name + " " + strings.Join(args, " ")
		f.calls = append(f.calls, call)
		switch {
		case name == "keepalived" && args[0] == "--version":
			return "Keepalived v2.2.8 (04/04,2023)", nil
		case name == "keepalived" && args[0] == "--config-test":
			if f.testFails {
				return "Unknown keyword 'bogus'", errors.New("exit status 1")
			}
			return "", nil
		case name == "systemctl" && args[0] == "is-active":
			return "active\n", nil
		case name == "systemctl" && args[0] == "is-enabled":
			return "enabled\n", nil
		}
		return "", nil
	}
	s.Verify = func(context.Context) error {
		if len(f.verifyErrs) == 0 {
			return nil
		}
		err := f.verifyErrs[0]
		f.verifyErrs = f.verifyErrs[1:]
		return err
	}
	s.Now = func() time.Time { return time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC) }
	return s
}

func request(t *testing.T) ApplyRequest {
	t.Helper()
	return ApplyRequest{Spec: json.RawMessage(baseSpec)}
}

func nop(string) {}

func TestApplyWritesIncludeAndConfig(t *testing.T) {
	f := &fakeRun{}
	s := testSystem(t, f)
	os.MkdirAll(filepath.Dir(s.MainConf), 0o755)
	os.WriteFile(s.MainConf, []byte(existing), 0o644)

	res, err := s.Apply(t.Context(), ApplyRequest{Spec: json.RawMessage(baseSpec), Migrate: []string{"VI_1"}},
		opener("s3cret"), nop)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Changed || res.Hash == "" {
		t.Fatalf("unexpected %+v", res)
	}
	main, _ := readFile(s.MainConf)
	if !strings.Contains(main, "include "+s.ManagedPath) || len(Import(main)) != 0 {
		t.Fatalf("main config not migrated:\n%s", main)
	}
	managed, _ := readFile(s.ManagedPath)
	if !strings.Contains(managed, "auth_pass s3cret") {
		t.Fatal("managed config missing password")
	}
	info, _ := os.Stat(s.ManagedPath)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("managed config must be root only, got %v", info.Mode().Perm())
	}
	backups, _ := filepath.Glob(s.MainConf + ".keepwatch-*")
	if len(backups) != 1 {
		t.Fatalf("expected a backup of keepalived.conf, got %v", backups)
	}
	if fi, err := os.Lstat(s.Paths.FIFO); err != nil || fi.Mode()&os.ModeNamedPipe == 0 {
		t.Fatal("FIFO not created")
	}
	again, err := s.Apply(t.Context(), request(t), opener("s3cret"), nop)
	if err != nil || again.Changed {
		t.Fatalf("second apply should be a no-op: %+v %v", again, err)
	}
}

func TestApplyStopsWhenKeepalivedRejectsTheConfig(t *testing.T) {
	f := &fakeRun{testFails: true}
	s := testSystem(t, f)
	_, err := s.Apply(t.Context(), request(t), opener("s3cret"), nop)
	if err == nil || !strings.Contains(err.Error(), "Unknown keyword") {
		t.Fatalf("expected the config test error, got %v", err)
	}
	if _, err := os.Stat(s.ManagedPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("config was written although the test failed")
	}
}

func TestApplyRollsBackWhenKeepalivedFails(t *testing.T) {
	f := &fakeRun{}
	s := testSystem(t, f)
	if _, err := s.Apply(t.Context(), request(t), opener("first"), nop); err != nil {
		t.Fatal(err)
	}
	before, _ := readFile(s.ManagedPath)
	f.verifyErrs = []error{errors.New("keepalived is failed")}
	res, err := s.Apply(t.Context(), request(t), opener("second"), nop)
	if err == nil || !res.RolledBack {
		t.Fatalf("expected a rollback, got %+v %v", res, err)
	}
	after, _ := readFile(s.ManagedPath)
	if after != before {
		t.Fatal("previous config was not restored")
	}
}

func TestMonitorModeNeverWrites(t *testing.T) {
	s := testSystem(t, &fakeRun{})
	if err := s.SetMode(ModeMonitor); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Apply(t.Context(), request(t), opener("x"), nop); err == nil {
		t.Fatal("applied in monitor mode")
	}
}

func TestPlanMasksPasswords(t *testing.T) {
	s := testSystem(t, &fakeRun{})
	plan, err := s.PlanApply(request(t), opener("s3cret"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(plan.Next, "s3cret") || !strings.Contains(plan.Next, "auth_pass ********") {
		t.Fatal("plan leaked the password")
	}
}

func TestScriptChecksNeedTheInstallFlag(t *testing.T) {
	s := testSystem(t, &fakeRun{})
	raw := strings.Replace(baseSpec, `"params":{"type":"process","process":"nginx"}`,
		`"params":{"type":"script","path":"/etc/keepwatch/scripts/db.sh"}`, 1)
	if _, err := s.PlanApply(ApplyRequest{Spec: json.RawMessage(raw)}, opener("x")); err == nil {
		t.Fatal("script check accepted without --allow-custom-scripts")
	}
}

func TestMaintenanceAndStatus(t *testing.T) {
	s := testSystem(t, &fakeRun{})
	if _, err := s.Apply(t.Context(), request(t), opener("x"), nop); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetMaintenance([]string{"VI_other"}, true); err == nil {
		t.Fatal("maintenance on an unmanaged instance")
	}
	if _, err := s.SetMaintenance(nil, true); err != nil {
		t.Fatal(err)
	}
	s.Tracker.Handle(`INSTANCE "VI_web" FAULT 100`, s.Now())
	st := s.Status(t.Context(), []Address{{Iface: "eth0", Address: "10.0.0.2", Prefix: 24}})
	if len(st.Instances) != 1 || st.Instances[0].State != "FAULT" || !st.Instances[0].Maintenance {
		t.Fatalf("unexpected %+v", st.Instances)
	}
	if st.Drift {
		t.Fatal("no drift expected")
	}
	os.WriteFile(s.ManagedPath, []byte("# edited by hand\n"), 0o600)
	if !s.Status(t.Context(), nil).Drift {
		t.Fatal("drift not detected")
	}
}

func TestStatusInfersMasterFromVIPs(t *testing.T) {
	s := testSystem(t, &fakeRun{})
	if _, err := s.Apply(t.Context(), request(t), opener("x"), nop); err != nil {
		t.Fatal(err)
	}
	holding := s.Status(t.Context(), []Address{{Iface: "eth0", Address: "10.0.0.10", Prefix: 24}})
	if holding.Instances[0].State != "MASTER" {
		t.Fatalf("expected MASTER, got %s", holding.Instances[0].State)
	}
	if s.Status(t.Context(), nil).Instances[0].State != "BACKUP" {
		t.Fatal("expected BACKUP without the VIP")
	}
}

func TestTrackerParsesFIFOLines(t *testing.T) {
	tr := NewTracker()
	now := time.Now()
	if !tr.Handle(`INSTANCE "VI_1" MASTER 150`, now) || tr.Handle(`INSTANCE "VI_1" MASTER 150`, now) {
		t.Fatal("expected one change")
	}
	if tr.Handle(`GROUP "G" MASTER`, now) || tr.Handle(`garbage`, now) {
		t.Fatal("ignored lines changed state")
	}
	tr.Handle(`INSTANCE "VI_1" BACKUP 100`, now)
	if got := tr.Snapshot()["VI_1"]; got.State != "BACKUP" || got.Priority != 100 {
		t.Fatalf("unexpected %+v", got)
	}
}

func TestChecksRecordTransitions(t *testing.T) {
	s := testSystem(t, &fakeRun{})
	s.recordResult("web", nil)
	first, _ := s.lastResult("web")
	s.Now = func() time.Time { return time.Date(2026, 1, 2, 4, 0, 0, 0, time.UTC) }
	s.recordResult("web", nil)
	if again, _ := s.lastResult("web"); again.Since != first.Since {
		t.Fatal("since moved without a transition")
	}
	s.recordResult("web", errors.New("connection refused"))
	if failed, _ := s.lastResult("web"); failed.OK || failed.Since == first.Since {
		t.Fatalf("unexpected %+v", failed)
	}
}

func TestSupportsConfigTest(t *testing.T) {
	for version, want := range map[string]bool{"2.2.8": true, "2.0.11": true, "2.0.10": false, "1.3.5": false} {
		if supportsConfigTest(version) != want {
			t.Errorf("%s: want %v", version, want)
		}
	}
}
