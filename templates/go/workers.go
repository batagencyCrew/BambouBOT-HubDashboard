package main

import (
	"context"
	"crypto/rand"
	"fmt"
	"runtime"
	"sync"
	"time"
)

type Worker struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	Status string  `json:"status"`
	CPU    float64 `json:"cpu_percent"`
	Memory float64 `json:"memory_mb"`
	Tasks  uint64  `json:"tasks_completed"`
	cancel context.CancelFunc
	done   chan struct{}
}

// Hook is the integration point for one bounded unit of your own business logic.
// Return completed=true only for a real completed task. Respect ctx cancellation.
// Errors are intentionally replaced by a static message before transmission.
type Hook func(context.Context, string, Config) (completed bool, err error)

func placeholder(ctx context.Context, id string, config Config) (bool, error) { return false, nil }

type Pool struct {
	control   sync.Mutex
	mu        sync.Mutex
	workers   []*Worker
	config    Config
	running   bool
	ctx       context.Context
	hook      Hook
	report    func(string)
	recovered bool
}

func (p *Pool) configure(c Config) {
	p.control.Lock()
	defer p.control.Unlock()
	running, _ := p.settings()
	p.reconcile(running, c)
}
func (p *Pool) lifecycle(action string) {
	p.control.Lock()
	defer p.control.Unlock()
	p.recovered = true
	_, c := p.settings()
	if action == "restart" {
		p.reconcile(false, c)
	}
	p.reconcile(action != "stop", c)
}
func (p *Pool) recoverDesired(desired string) {
	p.control.Lock()
	defer p.control.Unlock()
	if p.recovered {
		return
	}
	p.recovered = true
	_, c := p.settings()
	p.reconcile(desired == "running", c)
}

func uuid() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("OS random generator unavailable")
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (p *Pool) reconcile(running bool, c Config) {
	p.mu.Lock()
	p.running, p.config = running, c
	want := c.Workers
	if !running {
		want = 0
	}
	var removed []*Worker
	for len(p.workers) > want {
		w := p.workers[len(p.workers)-1]
		p.workers = p.workers[:len(p.workers)-1]
		w.cancel()
		removed = append(removed, w)
	}
	for len(p.workers) < want {
		ctx, cancel := context.WithCancel(p.ctx)
		w := &Worker{ID: uuid(), Name: fmt.Sprintf("worker-%d", len(p.workers)+1), Status: "idle", cancel: cancel, done: make(chan struct{})}
		p.workers = append(p.workers, w)
		go p.run(ctx, w)
	}
	p.mu.Unlock()
	for _, w := range removed {
		<-w.done
	}
}

func (p *Pool) run(ctx context.Context, w *Worker) {
	defer close(w.done)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		p.mu.Lock()
		c := p.config
		w.Status = "running"
		p.mu.Unlock()
		done, err := safeHook(p.hook, ctx, w.ID, c)
		p.mu.Lock()
		if done {
			w.Tasks++
		}
		w.Status = "idle"
		if err != nil {
			w.Status = "error"
		}
		p.mu.Unlock()
		if err != nil && ctx.Err() == nil && p.report != nil {
			p.report(w.ID)
		}
	}
}

func safeHook(h Hook, ctx context.Context, id string, c Config) (done bool, err error) {
	defer func() {
		if recover() != nil {
			done = false
			err = fmt.Errorf("worker hook panicked")
		}
	}()
	return h(ctx, id, c)
}

func (p *Pool) settings() (bool, Config) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.running, p.config
}
func (p *Pool) snapshot() []Worker {
	p.mu.Lock()
	defer p.mu.Unlock()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	result := make([]Worker, 0, len(p.workers))
	for _, w := range p.workers {
		copy := *w
		// Go workers share a process. This is an apportioned actual Go heap reading,
		// not per-goroutine RSS. CPU is unavailable and explicitly reported as zero.
		copy.Memory = float64(m.Alloc) / float64(1<<20) / float64(len(p.workers))
		result = append(result, copy)
	}
	return result
}
