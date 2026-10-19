package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

type Command struct {
	ID     string `json:"id"`
	Action string `json:"action"`
}
type Outcome struct {
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}
type CommandOutcome struct {
	Outcome
	Acked bool `json:"acked"`
}
type Agent struct {
	configMu                                      sync.Mutex
	api                                           *API
	runtimeDir, stateDir, seedConfig, seedProxies string
	pool                                          *Pool
	journal                                       map[string]CommandOutcome
}

func (a *Agent) syncConfig(ctx context.Context) error {
	a.configMu.Lock()
	defer a.configMu.Unlock()
	var c Config
	if err := a.api.json(ctx, "GET", "/config", nil, &c); err != nil {
		return err
	}
	var mark checkpoint
	err := readJSON(filepath.Join(a.runtimeDir, ".sync.json"), &mark)
	if err != nil && !os.IsNotExist(err) {
		return errors.New("invalid local sync checkpoint; refusing to reimport")
	}
	if !mark.Initialized {
		seed := map[string]any{}
		if !c.Initialized {
			var err error
			seed, err = localSeed(a.runtimeDir, a.seedConfig, a.seedProxies)
			if err != nil {
				return err
			}
		}
		seed["expected_revision"] = c.Revision
		err = a.api.json(ctx, "POST", "/local-sync", seed, &c)
		var status *HTTPError
		if errors.As(err, &status) && status.Status == 409 {
			if err = a.api.json(ctx, "GET", "/config", nil, &c); err != nil {
				return err
			}
			err = a.api.json(ctx, "POST", "/local-sync", map[string]any{"expected_revision": c.Revision}, &c)
		}
		if err != nil {
			return err
		} // Never overwrite local seeds on invalid import.
	}
	if err := publishConfig(a.runtimeDir, c); err != nil {
		return errors.New("cannot publish private configuration")
	}
	a.pool.configure(c)
	return nil
}

func (a *Agent) heartbeat(ctx context.Context) error {
	workers := a.pool.snapshot()
	status := "healthy"
	for _, w := range workers {
		if w.Status == "error" {
			status = "degraded"
		}
	}
	var reply struct {
		Desired string `json:"desired_state"`
	}
	if err := a.api.json(ctx, "POST", "/heartbeat", map[string]any{"status": status, "workers": workers}, &reply); err != nil {
		return err
	}
	a.pool.recoverDesired(reply.Desired)
	return nil
}

func (a *Agent) commands(ctx context.Context) error {
	if err := saveJSON(filepath.Join(a.stateDir, "commands.json"), a.journal); err != nil {
		return errors.New("cannot persist command outcomes")
	}
	// Flush durable outcomes before fetching work, even if the command no longer
	// appears in a delivered queue. Never repeat the local action on an ack retry.
	for id, outcome := range a.journal {
		if outcome.Acked {
			continue
		}
		if err := a.ackCommand(ctx, id); err != nil {
			return err
		}
	}
	var commands []Command
	if err := a.api.json(ctx, "GET", "/commands", nil, &commands); err != nil {
		return err
	}
	for _, cmd := range commands {
		if !validID(cmd.ID) {
			return errors.New("invalid command identifier")
		}
		if _, ok := a.journal[cmd.ID]; ok {
			continue
		}
		outcome := Outcome{Status: "completed"}
		switch cmd.Action {
		case "start", "restart":
			if err := a.syncConfig(ctx); err != nil {
				outcome = Outcome{"failed", "configuration refresh failed; lifecycle action not performed"}
			} else {
				a.pool.lifecycle(cmd.Action)
			}
		case "stop":
			a.pool.lifecycle("stop")
		default:
			outcome = Outcome{"failed", "unsupported lifecycle action"}
		}
		a.journal[cmd.ID] = CommandOutcome{Outcome: outcome}
		if err := saveJSON(filepath.Join(a.stateDir, "commands.json"), a.journal); err != nil {
			// Retain in memory and retry publication before any acknowledgement.
			return errors.New("cannot persist command outcome")
		}
		if err := a.ackCommand(ctx, cmd.ID); err != nil {
			return err
		}
	}
	return nil
}

func (a *Agent) ackCommand(ctx context.Context, id string) error {
	outcome := a.journal[id]
	err := a.api.json(ctx, "POST", "/commands/"+id+"/ack", outcome.Outcome, nil)
	var status *HTTPError
	if err != nil && !(errors.As(err, &status) && (status.Status == 404 || status.Status == 409)) {
		return err
	}
	// Missing/pruned or superseded commands are terminal; retain dedup but stop
	// retrying their acknowledgements so they cannot block subsequent commands.
	outcome.Acked = true
	a.journal[id] = outcome
	if saveJSON(filepath.Join(a.stateDir, "commands.json"), a.journal) != nil {
		return errors.New("cannot persist command acknowledgement")
	}
	return nil
}

func validID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if c != '-' {
				return false
			}
		} else if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

func loop(ctx context.Context, interval time.Duration, f func(context.Context) error) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		if err := f(ctx); err != nil && ctx.Err() == nil {
			log.Printf("agent operation failed: %s", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func run() error {
	api, err := newAPI(os.Getenv("HUB_URL"), os.Getenv("HUB_AGENT_TOKEN"))
	if err != nil {
		return err
	}
	runtimeDir, err := filepath.Abs(env("HUB_RUNTIME_DIR", "./runtime"))
	if err != nil {
		return err
	}
	stateDir, err := filepath.Abs(env("HUB_STATE_DIR", filepath.Join(runtimeDir, "state")))
	if err != nil {
		return err
	}
	if err = privateDir(runtimeDir); err != nil {
		return errors.New("cannot prepare private runtime directory")
	}
	if err = privateDir(stateDir); err != nil {
		return errors.New("cannot prepare private state directory")
	}
	runtimeDir, err = filepath.EvalSymlinks(runtimeDir)
	if err != nil {
		return errors.New("cannot resolve runtime directory")
	}
	stateDir, err = filepath.EvalSymlinks(stateDir)
	if err != nil {
		return errors.New("cannot resolve state directory")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	pool := &Pool{ctx: ctx, hook: placeholder}
	errorsQueue := make(chan string, 100)
	pool.report = func(id string) {
		select {
		case errorsQueue <- id:
		default:
		}
	}
	a := &Agent{api: api, runtimeDir: runtimeDir, stateDir: stateDir, seedConfig: env("HUB_LOCAL_CONFIG", "./localconfig.json"), seedProxies: env("HUB_LOCAL_PROXIES", "./localproxies.txt"), pool: pool, journal: map[string]CommandOutcome{}}
	if err = readJSON(filepath.Join(stateDir, "commands.json"), &a.journal); err != nil && !os.IsNotExist(err) {
		return errors.New("invalid command journal; refusing unsafe replay")
	}
	if a.journal == nil {
		return errors.New("invalid command journal")
	}
	for id, outcome := range a.journal {
		if !validID(id) || (outcome.Status != "completed" && outcome.Status != "failed") {
			return errors.New("invalid command journal")
		}
	}
	backup, err := newBackup(api, runtimeDir, stateDir)
	if err != nil {
		return err
	}
	// Do not start workers until first enrollment has succeeded. Transient failures
	// retry without replacing seed files. Backups remain independent thereafter.
	for {
		if err = a.syncConfig(ctx); err == nil {
			break
		}
		log.Print("initial configuration unavailable (local files preserved)")
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(5 * time.Second):
		}
	}
	_ = a.heartbeat(ctx)
	var wg sync.WaitGroup
	start := func(f func()) { wg.Add(1); go func() { defer wg.Done(); f() }() }
	start(func() { loop(ctx, 30*time.Second, a.syncConfig) })
	start(func() { loop(ctx, 15*time.Second, a.heartbeat) })
	start(func() { loop(ctx, 5*time.Second, a.commands) })
	start(func() { backup.run(ctx) })
	start(func() {
		for {
			select {
			case <-ctx.Done():
				return
			case id := <-errorsQueue:
				_ = api.json(ctx, "POST", "/errors", map[string]any{"worker_id": id, "level": "error", "message": "worker hook failed"}, nil)
			}
		}
	})
	<-ctx.Done()
	wg.Wait()
	pool.lifecycle("stop")
	return nil
}
func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
