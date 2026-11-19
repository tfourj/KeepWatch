package main

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/tfourj/KeepWatch/agent/internal/keepalived"
)

// Every command the server can send must have a handler here or be built into core.
func TestHandlersCoverServerCommands(t *testing.T) {
	src, err := os.ReadFile("../../../src/server/agents/protocol.ts")
	if err != nil {
		t.Skip("server source not available")
	}
	block := regexp.MustCompile(`(?s)COMMAND_TYPES = \[(.*?)\]`).FindSubmatch(src)
	if block == nil {
		t.Fatal("COMMAND_TYPES not found")
	}
	handlers := (&kaAgent{sys: keepalived.NewSystem(t.TempDir(), binaryPath)}).handlers()
	builtin := map[string]bool{"update": true, "unpair": true, "ping": true}
	for _, m := range regexp.MustCompile(`"([a-z_]+)"`).FindAllSubmatch(block[1], -1) {
		name := string(m[1])
		if _, ok := handlers[name]; !ok && !builtin[name] {
			t.Errorf("no handler for %s", name)
		}
	}
}

func TestDecodeRejectsUnknownFields(t *testing.T) {
	var args struct {
		Action string `json:"action"`
	}
	if err := decode(json.RawMessage(`{"action":"reload","cmd":"sh"}`), &args); err == nil {
		t.Fatal("unknown field accepted")
	}
	if err := decode(json.RawMessage(`{"action":"reload"}`), &args); err != nil || args.Action != "reload" {
		t.Fatal("valid arguments rejected")
	}
}

func TestUnitKeepsSandbox(t *testing.T) {
	for _, want := range []string{"ProtectSystem=strict", "NoNewPrivileges=yes", "RuntimeDirectory=keepwatch",
		"ReadWritePaths=/var/lib/keepwatch-agent /usr/local/bin -/etc/keepalived"} {
		if !strings.Contains(unit, want) {
			t.Errorf("unit misses %q", want)
		}
	}
}
