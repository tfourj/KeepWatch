package keepalived

import (
	"strings"
	"testing"
)

const existing = `! Configuration File for keepalived
global_defs {
   router_id LVS_DEVEL
}

vrrp_instance VI_1 {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 150 # primary
    advert_int 1
    nopreempt
    authentication {
        auth_type PASS
        auth_pass 1111
    }
    virtual_ipaddress {
        192.168.200.16/24 dev eth0
        192.168.200.17
    }
    notify_master "/etc/keepalived/master.sh"
}
`

func TestImportReadsInstancesWithoutPasswords(t *testing.T) {
	got := Import(existing)
	if len(got) != 1 {
		t.Fatalf("expected one instance, got %d", len(got))
	}
	in := got[0]
	if in.Name != "VI_1" || in.State != "MASTER" || in.VRID != 51 || in.Priority != 150 || in.Preempt {
		t.Fatalf("unexpected %+v", in)
	}
	if len(in.VirtualIPs) != 2 || in.VirtualIPs[0].Prefix != 24 || in.VirtualIPs[1].Prefix != 32 {
		t.Fatalf("unexpected VIPs %+v", in.VirtualIPs)
	}
	if !in.HasPassword || in.AuthPass != "" {
		t.Fatal("password must be noted but not read")
	}
	if len(in.Unsupported) != 1 || in.Unsupported[0] != "notify_master" {
		t.Fatalf("unsupported %v", in.Unsupported)
	}
}

func TestIncludeBlockAndCommentOut(t *testing.T) {
	conf := withInclude(existing, "/etc/keepalived/conf.d/keepwatch.conf")
	if !strings.Contains(conf, "include /etc/keepalived/conf.d/keepwatch.conf") {
		t.Fatal("include missing")
	}
	if withInclude(conf, "/etc/keepalived/conf.d/keepwatch.conf") != conf {
		t.Fatal("adding the include twice changed the file")
	}
	migrated := CommentOut(conf, map[string]bool{"VI_1": true})
	if len(Import(migrated)) != 0 {
		t.Fatal("instance still active after comment out")
	}
	if !strings.Contains(migrated, "router_id LVS_DEVEL") || !strings.Contains(migrated, blockBegin) {
		t.Fatal("other config was touched")
	}
	if strings.Count(migrated, migratedMark) != strings.Count(existing[strings.Index(existing, "vrrp_instance"):], "\n") {
		t.Fatalf("expected every instance line commented:\n%s", migrated)
	}
}

func TestConflictOnUserFIFO(t *testing.T) {
	if Conflict(existing) != "" {
		t.Fatal("no conflict expected")
	}
	if Conflict("global_defs {\n vrrp_notify_fifo /tmp/f\n}\n") == "" {
		t.Fatal("expected a conflict")
	}
	if Conflict("# vrrp_notify_fifo /tmp/f\n") != "" {
		t.Fatal("comments are not a conflict")
	}
}
