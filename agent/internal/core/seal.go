package core

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Sealed values carry secrets end to end from the server to this agent, so a proxy that terminates TLS never sees
// them. Keep in sync with src/server/crypto/sealing.ts.
//
//	s1:<base64url(ephemeralPublic[32] | iv[12] | ciphertext | tag[16])>
//
// key = HKDF-SHA256(X25519(agent, ephemeral), salt = ephemeralPublic | agentPublic, info = "keepwatch-seal-v1")
const (
	sealVersion = "s1:"
	sealInfo    = "keepwatch-seal-v1"
)

// Open decrypts a sealed value with the agent's X25519 key. aad must match what the server sealed it with.
func Open(key *ecdh.PrivateKey, sealed, aad string) (string, error) {
	if !strings.HasPrefix(sealed, sealVersion) {
		return "", errors.New("unsupported sealed format")
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(sealed, sealVersion))
	if err != nil || len(raw) < 32+12+16 {
		return "", errors.New("malformed sealed value")
	}
	ephRaw, iv, body := raw[:32], raw[32:44], raw[44:]
	eph, err := ecdh.X25519().NewPublicKey(ephRaw)
	if err != nil {
		return "", errors.New("malformed sealed value")
	}
	shared, err := key.ECDH(eph)
	if err != nil {
		return "", err
	}
	salt := append(append([]byte{}, ephRaw...), key.PublicKey().Bytes()...)
	aesKey, err := hkdf.Key(sha256.New, shared, salt, sealInfo, 32)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(aesKey)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, iv, body, []byte(aad))
	if err != nil {
		return "", errors.New("sealed value could not be opened")
	}
	return string(plain), nil
}

func (s *PersistedState) sealKey() (*ecdh.PrivateKey, error) {
	raw, err := base64.RawURLEncoding.DecodeString(s.SealKey)
	if err != nil {
		return nil, errors.New("stored seal key is invalid")
	}
	return ecdh.X25519().NewPrivateKey(raw)
}

// pendingSealKey reuses the key of an interrupted enrollment, like the signing key, so a retry is accepted.
func pendingSealKey(dir string) (*ecdh.PrivateKey, error) {
	path := filepath.Join(dir, "pending-seal-key")
	if data, err := os.ReadFile(path); err == nil && len(data) == 32 {
		return ecdh.X25519().NewPrivateKey(data)
	}
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, key.Bytes(), 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

type openerKey struct{}

// Opener opens sealed values of the command being handled.
type Opener func(sealed string) (string, error)

func withOpener(ctx context.Context, open Opener) context.Context {
	return context.WithValue(ctx, openerKey{}, open)
}

// OpenSealed opens a sealed value sent with the current command. It fails outside a command handler.
func OpenSealed(ctx context.Context, sealed string) (string, error) {
	open, ok := ctx.Value(openerKey{}).(Opener)
	if !ok {
		return "", errors.New("no command to open sealed values for")
	}
	return open(sealed)
}

func (a *Agent) opener(cmd *Command) Opener {
	return func(sealed string) (string, error) {
		if a.seal == nil {
			return "", errors.New("agent has no seal key, pair it again")
		}
		return Open(a.seal, sealed, cmd.AgentID+"\n"+cmd.ID)
	}
}
