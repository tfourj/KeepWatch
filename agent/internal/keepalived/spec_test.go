package keepalived

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

const baseSpec = `{"version":1,"instances":[{"name":"VI_web","vrid":51,"vrrpVersion":2,"interface":"eth0",
"state":"BACKUP","priority":100,"advertInt":1,"preempt":true,"preemptDelay":0,"unicastSrcIp":"10.0.0.2",
"unicastPeers":["10.0.0.3"],"virtualIps":[{"address":"10.0.0.10","prefix":24}],"authPass":"s1:x",
"trackInterfaces":[{"name":"eth1","weight":-20}],"checks":["web","nginx"]}],
"checks":[{"id":"web","params":{"type":"http","url":"http://127.0.0.1/health","expectStatus":200},
"intervalSec":2,"timeoutSec":2,"fall":2,"rise":2,"weight":-30},
{"id":"nginx","params":{"type":"process","process":"nginx"},"intervalSec":1,"timeoutSec":1,"fall":1,"rise":1,
"weight":0}]}`

var paths = Paths{Binary: "/usr/local/bin/keepwatch-agent", MaintenanceDir: "/var/lib/kw/maint", FIFO: "/run/kw.fifo"}

func opener(pass string) Opener {
	return func(string) (string, error) { return pass, nil }
}

func mutate(t *testing.T, edit func(m map[string]any)) json.RawMessage {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(baseSpec), &m); err != nil {
		t.Fatal(err)
	}
	edit(m)
	raw, _ := json.Marshal(m)
	return raw
}

func instance(m map[string]any) map[string]any {
	return m["instances"].([]any)[0].(map[string]any)
}

func TestRenderSpec(t *testing.T) {
	spec, err := ParseSpec(json.RawMessage(baseSpec))
	if err != nil {
		t.Fatal(err)
	}
	out, err := Render(spec, paths, opener("s3cret"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"vrrp_notify_fifo /run/kw.fifo",
		`script "/usr/local/bin/keepwatch-agent check web"`,
		"vrrp_track_process kw_proc_nginx {",
		"vrrp_track_file kw_maint_VI_web {",
		"file /var/lib/kw/maint/VI_web",
		"virtual_router_id 51",
		"auth_pass s3cret",
		"10.0.0.10/24 dev eth0",
		"eth1 weight -20",
		"kw_chk_web",
		"kw_proc_nginx",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in\n%s", want, out)
		}
	}
	if strings.Count(out, "{") != strings.Count(out, "}") {
		t.Fatal("unbalanced braces")
	}
}

func TestRejectsInjection(t *testing.T) {
	cases := map[string]func(m map[string]any){
		"name":      func(m map[string]any) { instance(m)["name"] = "VI}\nglobal_defs {" },
		"interface": func(m map[string]any) { instance(m)["interface"] = "eth0 }" },
		"address": func(m map[string]any) {
			instance(m)["virtualIps"] = []any{map[string]any{"address": "1.2.3.4\n}", "prefix": 24}}
		},
		"peer":    func(m map[string]any) { instance(m)["unicastPeers"] = []any{"10.0.0.3 }"} },
		"unknown": func(m map[string]any) { instance(m)["notify_master"] = "/bin/sh" },
		"script": func(m map[string]any) {
			m["checks"] = []any{map[string]any{"id": "x", "params": map[string]any{"type": "script", "path": "/bin/sh"}, "intervalSec": 1, "timeoutSec": 1, "fall": 1, "rise": 1}}
		},
		"url": func(m map[string]any) {
			m["checks"].([]any)[0].(map[string]any)["params"].(map[string]any)["url"] = "http://x/\" }"
		},
	}
	for name, edit := range cases {
		if _, err := ParseSpec(mutate(t, edit)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestPasswordsAreCheckedAfterOpening(t *testing.T) {
	spec, _ := ParseSpec(json.RawMessage(baseSpec))
	for _, bad := range []string{"a b", "a}b", "a#b", "123456789", ""} {
		if _, err := Render(spec, paths, opener(bad)); err == nil {
			t.Errorf("accepted password %q", bad)
		}
	}
	failing := func(string) (string, error) { return "", errors.New("sealed value could not be opened") }
	if _, err := Render(spec, paths, failing); err == nil {
		t.Error("rendered without opening the password")
	}
}

func TestCrossFieldRules(t *testing.T) {
	v6 := func(m map[string]any) {
		instance(m)["virtualIps"] = []any{map[string]any{"address": "fd00::1", "prefix": 64}}
	}
	if _, err := ParseSpec(mutate(t, v6)); err == nil || !strings.Contains(err.Error(), "version 3") {
		t.Errorf("IPv6 with VRRPv2: %v", err)
	}
	nopreempt := func(m map[string]any) { instance(m)["preempt"] = false; instance(m)["state"] = "MASTER" }
	if _, err := ParseSpec(mutate(t, nopreempt)); err == nil {
		t.Error("nopreempt with MASTER accepted")
	}
	missing := func(m map[string]any) { instance(m)["checks"] = []any{"nope"} }
	if _, err := ParseSpec(mutate(t, missing)); err == nil {
		t.Error("unknown check accepted")
	}
}
