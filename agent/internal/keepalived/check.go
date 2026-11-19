package keepalived

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

func (s *System) checksPath() string { return filepath.Join(s.StateDir, "checks.json") }

func (s *System) resultPath(id string) string {
	return filepath.Join(s.StateDir, "check-results", id+".json")
}

type checkResult struct {
	OK    bool   `json:"ok"`
	Since int64  `json:"since"`
	Error string `json:"error,omitempty"`
}

func (s *System) lastResult(id string) (checkResult, bool) {
	var r checkResult
	data, err := os.ReadFile(s.resultPath(id))
	if err != nil {
		return r, false
	}
	return r, json.Unmarshal(data, &r) == nil
}

// RunCheck runs one health check for keepalived (`keepwatch-agent check <id>`). Exit code 0 means healthy.
func (s *System) RunCheck(ctx context.Context, id string) error {
	if !checkIDRe.MatchString(id) {
		return errors.New("invalid check id")
	}
	if err := rootOwnedNotWritable(s.checksPath()); err != nil && os.Getuid() == 0 {
		return err
	}
	data, err := os.ReadFile(s.checksPath())
	if err != nil {
		return err
	}
	var checks []Check
	if err := json.Unmarshal(data, &checks); err != nil {
		return err
	}
	for _, c := range checks {
		if c.ID != id {
			continue
		}
		if err := c.validate(); err != nil {
			return err
		}
		timeout := time.Duration(c.TimeoutSec) * time.Second
		runCtx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		checkErr := s.probe(runCtx, c, timeout)
		s.recordResult(id, checkErr)
		return checkErr
	}
	return fmt.Errorf("unknown check %s", id)
}

func (s *System) recordResult(id string, checkErr error) {
	now := s.Now().UnixMilli()
	next := checkResult{OK: checkErr == nil, Since: now}
	if checkErr != nil {
		next.Error = truncate(checkErr.Error(), 300)
	}
	if prev, ok := s.lastResult(id); ok && prev.OK == next.OK {
		next.Since = prev.Since
		if prev.Error == next.Error {
			return
		}
	}
	data, _ := json.Marshal(next)
	_ = writeAtomic(s.resultPath(id), data, 0o600)
}

func (s *System) probe(ctx context.Context, c Check, timeout time.Duration) error {
	p := c.Params
	switch p.Type {
	case "tcp":
		var d net.Dialer
		conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(p.Host, strconv.Itoa(p.Port)))
		if err != nil {
			return err
		}
		return conn.Close()
	case "http":
		client := &http.Client{
			Timeout: timeout,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: p.InsecureTLS}, //nolint:gosec // opt-in per check
				Proxy:           nil,
			},
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.URL, nil)
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", "keepwatch-check")
		resp, err := client.Do(req)
		if err != nil {
			return err
		}
		resp.Body.Close()
		if resp.StatusCode != p.ExpectStatus {
			return fmt.Errorf("status %d, expected %d", resp.StatusCode, p.ExpectStatus)
		}
		return nil
	case "ping":
		secs := strconv.Itoa(max(1, int(timeout.Seconds())))
		out, err := s.Run(ctx, "ping", "-c", "1", "-W", secs, "--", p.Host)
		if err != nil {
			return fmt.Errorf("no reply: %s", truncate(out, 200))
		}
		return nil
	case "script":
		if !s.CustomScriptsAllowed() {
			return errors.New("custom scripts are off on this node")
		}
		if err := rootOwnedNotWritable(ScriptDir); err != nil {
			return err
		}
		if err := rootOwnedNotWritable(p.Path); err != nil {
			return err
		}
		cmd := exec.CommandContext(ctx, p.Path)
		cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"}
		cmd.Dir = ScriptDir
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("%v: %s", err, truncate(string(out), 200))
		}
		return nil
	}
	return fmt.Errorf("check type %s is not run by the agent", p.Type)
}
