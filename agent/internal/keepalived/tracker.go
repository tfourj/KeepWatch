package keepalived

import (
	"bufio"
	"context"
	"os"
	"regexp"
	"strconv"
	"sync"
	"time"
)

// InstanceState is the last state keepalived reported for an instance.
type InstanceState struct {
	State    string
	Priority int
	Since    time.Time
}

// Tracker keeps instance states from keepalived's notify FIFO.
type Tracker struct {
	mu     sync.Mutex
	states map[string]InstanceState
	// Changed is signalled after every state change.
	Changed chan struct{}
}

func NewTracker() *Tracker {
	return &Tracker{states: map[string]InstanceState{}, Changed: make(chan struct{}, 1)}
}

// fifoLine matches lines like: INSTANCE "VI_1" MASTER 100
var fifoLine = regexp.MustCompile(`^INSTANCE\s+"?([A-Za-z0-9_.-]{1,64})"?\s+(MASTER|BACKUP|FAULT|STOP|DELETED)\s+(\d+)`)

// Handle records one FIFO line. It returns whether a state changed.
func (t *Tracker) Handle(line string, now time.Time) bool {
	m := fifoLine.FindStringSubmatch(line)
	if m == nil {
		return false
	}
	name, state := m[1], m[2]
	prio, _ := strconv.Atoi(m[3])
	t.mu.Lock()
	defer t.mu.Unlock()
	if state == "DELETED" {
		_, had := t.states[name]
		delete(t.states, name)
		return had
	}
	prev, had := t.states[name]
	if had && prev.State == state && prev.Priority == prio {
		return false
	}
	since := now
	if had && prev.State == state {
		since = prev.Since
	}
	t.states[name] = InstanceState{State: state, Priority: prio, Since: since}
	select {
	case t.Changed <- struct{}{}:
	default:
	}
	return true
}

// Snapshot returns a copy of the known states.
func (t *Tracker) Snapshot() map[string]InstanceState {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make(map[string]InstanceState, len(t.states))
	for k, v := range t.states {
		out[k] = v
	}
	return out
}

// Follow reads the FIFO until ctx ends. Opening it read-write keeps it open when keepalived restarts.
func (t *Tracker) Follow(ctx context.Context, path string, logf func(string, ...any)) {
	for ctx.Err() == nil {
		if err := EnsureFIFO(path); err != nil {
			logf("could not create the notify FIFO: %v", err)
			sleep(ctx, 30*time.Second)
			continue
		}
		f, err := os.OpenFile(path, os.O_RDWR, 0)
		if err != nil {
			logf("could not open the notify FIFO: %v", err)
			sleep(ctx, 30*time.Second)
			continue
		}
		go func() {
			<-ctx.Done()
			f.Close()
		}()
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 4096), 4096)
		for scanner.Scan() {
			t.Handle(scanner.Text(), time.Now())
		}
		f.Close()
		sleep(ctx, time.Second)
	}
}

func sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}
