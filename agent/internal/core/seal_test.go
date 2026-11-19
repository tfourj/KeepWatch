package core

import (
	"context"
	"crypto/ecdh"
	"encoding/base64"
	"testing"
)

// Produced by src/server/crypto/sealing.ts: seal(publicKey, "pa55w0rd", "a1\nc1").
const (
	testSealKey = "T_Z-ueXLvpUU9RK90B8hsTGeF5Yvny1KAuuPpQ8x-5M"
	testSealed  = "s1:Q2pGFwU-28MYMk8OGjIr4H_aj0btO0mc8r9Qevz5yzegQg_G8quPrzwOGNmuPkwy5QqQPbZNMYsCjxY7kH31fZ0lVJM"
)

func testSealPrivate(t *testing.T) *ecdh.PrivateKey {
	t.Helper()
	raw, _ := base64.RawURLEncoding.DecodeString(testSealKey)
	key, err := ecdh.X25519().NewPrivateKey(raw)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func TestOpenServerSealedValue(t *testing.T) {
	plain, err := Open(testSealPrivate(t), testSealed, "a1\nc1")
	if err != nil || plain != "pa55w0rd" {
		t.Fatalf("got %q, %v", plain, err)
	}
}

func TestOpenRejectsOtherContextAndTampering(t *testing.T) {
	key := testSealPrivate(t)
	if _, err := Open(key, testSealed, "a1\nc2"); err == nil {
		t.Fatal("opened with the wrong command id")
	}
	raw := []byte(testSealed)
	raw[len(raw)-3] ^= 1
	if _, err := Open(key, string(raw), "a1\nc1"); err == nil {
		t.Fatal("opened a tampered value")
	}
	if _, err := Open(key, "v1:abc", "a1\nc1"); err == nil {
		t.Fatal("opened an unknown format")
	}
}

func TestOpenSealedNeedsACommand(t *testing.T) {
	if _, err := OpenSealed(context.Background(), testSealed); err == nil {
		t.Fatal("opened outside a command")
	}
	a, _ := newTestAgent(t, nil)
	ctx := withOpener(context.Background(), a.opener(&Command{ID: "c1", AgentID: "a1"}))
	if plain, err := OpenSealed(ctx, testSealed); err != nil || plain != "pa55w0rd" {
		t.Fatalf("got %q, %v", plain, err)
	}
}
