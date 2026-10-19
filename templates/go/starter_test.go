package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func writeTest(t *testing.T, path string, b []byte) {
	t.Helper()
	if err := os.WriteFile(path, b, 0600); err != nil {
		t.Fatal(err)
	}
}
func readTest(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func apiTest(t *testing.T, h http.HandlerFunc) *API {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Error("missing site authentication")
		}
		h(w, r)
	}))
	t.Cleanup(s.Close)
	a, err := newAPI(s.URL, "test-token")
	if err != nil {
		t.Fatal(err)
	}
	return a
}
func agentTest(t *testing.T, api *API) *Agent {
	t.Helper()
	dir := t.TempDir()
	state := filepath.Join(dir, "state")
	if err := privateDir(state); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &Pool{ctx: ctx, hook: placeholder}
	t.Cleanup(func() { cancel(); p.lifecycle("stop") })
	return &Agent{api: api, runtimeDir: dir, stateDir: state, seedConfig: filepath.Join(dir, "localconfig.json"), seedProxies: filepath.Join(dir, "localproxies.txt"), pool: p, journal: map[string]CommandOutcome{}}
}

func TestOriginsAndTLS(t *testing.T) {
	for _, origin := range []string{"http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?x=1", "https://example.com?", "https://example.com/#", "https://example.com/#x", "file:///tmp/a", "//example.com"} {
		if _, err := newAPI(origin, "token"); err == nil {
			t.Errorf("accepted %s", origin)
		}
	}
	for _, origin := range []string{"https://example.com", "http://localhost:8000", "http://127.0.0.1:8000", "http://[::1]:8000"} {
		if _, err := newAPI(origin, "token"); err != nil {
			t.Errorf("rejected valid origin: %s", err)
		}
	}
	if _, err := newAPI("https://example.com", ""); err == nil {
		t.Fatal("empty token accepted")
	}
	s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{}`)) }))
	defer s.Close()
	a, _ := newAPI(s.URL, "token")
	if err := a.json(context.Background(), "GET", "/config", nil, nil); err == nil {
		t.Fatal("untrusted TLS certificate accepted")
	}
}

func TestRedirectAndErrorSanitization(t *testing.T) {
	called := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer target.Close()
	a := apiTest(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/secret", http.StatusFound)
	})
	err := a.json(context.Background(), "GET", "/config", nil, nil)
	if err == nil || called {
		t.Fatal("followed redirect")
	}
	a = apiTest(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500); w.Write([]byte("password-secret")) })
	err = a.json(context.Background(), "GET", "/config", nil, nil)
	if err == nil || strings.Contains(err.Error(), "password-secret") {
		t.Fatal("unsafe HTTP error")
	}
}

func TestProxyEncodingAndPublication(t *testing.T) {
	p := Proxy{URL: "socks5://[2001:db8::1]:1080", Username: "a@:/%", Password: "p@:/%?#"}
	got, err := proxyURL(p)
	if err != nil {
		t.Fatal(err)
	}
	if got != "socks5://a%40%3A%2F%25:p%40%3A%2F%25%3F%23@[2001:db8::1]:1080" {
		t.Fatalf("bad escaping: %s", got)
	}
	for _, bad := range []string{"http://u:p@host:1", "http://host:0", "ftp://host:21", "http://host:80/path", "http://host:80?x=1"} {
		if _, err := proxyURL(Proxy{URL: bad}); err == nil {
			t.Errorf("accepted invalid proxy %s", bad)
		}
	}
	dir := t.TempDir()
	if err := privateDir(dir); err != nil {
		t.Fatal(err)
	}
	c := Config{Workers: 2, Key: "private-ai", Preset: "p", Revision: 3, Initialized: true, Proxies: []Proxy{p}}
	if err := publishConfig(dir, c); err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := readJSON(filepath.Join(dir, "config.json"), &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) != 4 || raw["revision"] != float64(3) {
		t.Fatalf("unexpected config fields: %#v", raw)
	}
	for _, name := range []string{"config.json", "proxies.txt", ".sync.json"} {
		fi, err := os.Stat(filepath.Join(dir, name))
		if err != nil || fi.Mode().Perm() != 0600 {
			t.Fatalf("not private: %s", name)
		}
	}
	c.Key = ""
	c.Proxies = nil
	c.Revision++
	if err := publishConfig(dir, c); err != nil {
		t.Fatal(err)
	}
	if len(readTest(t, filepath.Join(dir, "proxies.txt"))) != 0 {
		t.Fatal("deleted proxy remained")
	}
	var mark checkpoint
	_ = readJSON(filepath.Join(dir, ".sync.json"), &mark)
	if !mark.Initialized || mark.Revision != 4 {
		t.Fatal("bad last checkpoint")
	}
	if bytes.Contains(readTest(t, filepath.Join(dir, "config.json")), []byte("private-ai")) {
		t.Fatal("cleared key remained")
	}
}

func TestEnrollmentRevisionRaceAndAuthoritativeRefresh(t *testing.T) {
	c := Config{Workers: 1, Revision: 2, Key: "hub-key", Initialized: false}
	posts, gets := 0, 0
	a := apiTest(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agent/config":
			gets++
			json.NewEncoder(w).Encode(c)
		case "/api/agent/local-sync":
			posts++
			var body map[string]json.RawMessage
			_ = json.NewDecoder(r.Body).Decode(&body)
			if posts == 1 {
				if len(body) != 3 || !bytes.Contains(body["proxies_content"], []byte("localhost")) {
					t.Error("missing seeds")
				}
				c.Revision = 3
				w.WriteHeader(409)
				return
			}
			if len(body) != 1 || string(body["expected_revision"]) != "3" {
				t.Errorf("stale seed retry: %#v", body)
			}
			c.Revision = 4
			c.Initialized = true
			json.NewEncoder(w).Encode(c)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	})
	ag := agentTest(t, a)
	writeTest(t, filepath.Join(ag.runtimeDir, "config.json"), []byte(`{"ai_api_key":"seed","number_of_workers":2,"revision":999}`))
	writeTest(t, filepath.Join(ag.runtimeDir, "proxies.txt"), []byte("# hello\nhttp://localhost:8080\n"))
	if err := ag.syncConfig(context.Background()); err != nil {
		t.Fatal(err)
	}
	if posts != 2 || gets != 2 {
		t.Fatalf("wrong request sequence %d/%d", posts, gets)
	}
	writeTest(t, filepath.Join(ag.runtimeDir, "config.json"), []byte(`{"ai_api_key":"manual-edit"}`))
	c.Key = ""
	c.Revision = 5
	if err := ag.syncConfig(context.Background()); err != nil {
		t.Fatal(err)
	}
	if posts != 2 || bytes.Contains(readTest(t, filepath.Join(ag.runtimeDir, "config.json")), []byte("manual-edit")) {
		t.Fatal("hub not authoritative")
	}
}

func TestInvalidImportPreservesSeedsAndCheckpoint(t *testing.T) {
	a := apiTest(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			w.WriteHeader(422)
			return
		}
		json.NewEncoder(w).Encode(Config{Workers: 1, Revision: 0})
	})
	ag := agentTest(t, a)
	seed := []byte("invalid-proxy\n")
	writeTest(t, filepath.Join(ag.runtimeDir, "proxies.txt"), seed)
	if err := ag.syncConfig(context.Background()); err == nil {
		t.Fatal("accepted invalid import")
	}
	if !bytes.Equal(readTest(t, filepath.Join(ag.runtimeDir, "proxies.txt")), seed) {
		t.Fatal("overwrote seed")
	}
	if _, err := os.Stat(filepath.Join(ag.runtimeDir, ".sync.json")); !os.IsNotExist(err) {
		t.Fatal("checkpoint created on failed sync")
	}
	writeTest(t, ag.seedConfig, []byte(`{"number_of_workers":null}`))
	if _, err := localSeed(ag.runtimeDir, ag.seedConfig, ag.seedProxies); err == nil {
		t.Fatal("null local workers accepted")
	}
}

func TestEnrollmentWithoutLocalData(t *testing.T) {
	posts := 0
	a := apiTest(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			posts++
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if len(body) != 1 || body["expected_revision"] != float64(0) {
				t.Error("empty enrollment not finalized")
			}
		}
		json.NewEncoder(w).Encode(Config{Workers: 1, Revision: 0, Initialized: r.Method == "POST"})
	})
	ag := agentTest(t, a)
	if err := ag.syncConfig(context.Background()); err != nil {
		t.Fatal(err)
	}
	if posts != 1 {
		t.Fatal("no local-sync call")
	}
}

func TestCommandDedupBeforeAckRetryAndReload(t *testing.T) {
	id := uuid()
	acks := 0
	var ag *Agent
	a := apiTest(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agent/config" {
			json.NewEncoder(w).Encode(Config{Workers: 1, Revision: 1, Initialized: true})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/ack") {
			acks++
			var journal map[string]CommandOutcome
			if err := readJSON(filepath.Join(ag.stateDir, "commands.json"), &journal); err != nil || journal[id].Status != "completed" {
				t.Error("ack before durable outcome")
			}
			if acks == 1 {
				w.WriteHeader(503)
				return
			}
			w.Write([]byte(`{}`))
			return
		}
		json.NewEncoder(w).Encode([]Command{{id, "restart"}})
	})
	ag = agentTest(t, a)
	if err := saveJSON(filepath.Join(ag.runtimeDir, ".sync.json"), checkpoint{true, 1}); err != nil {
		t.Fatal(err)
	}
	ag.pool.configure(Config{Workers: 1})
	ag.pool.lifecycle("start")
	if err := ag.commands(context.Background()); err == nil {
		t.Fatal("expected failed ack")
	}
	worker := ag.pool.snapshot()[0].ID
	if err := ag.commands(context.Background()); err != nil {
		t.Fatal(err)
	}
	if ag.pool.snapshot()[0].ID != worker || acks != 2 {
		t.Fatal("repeated lifecycle action on ack retry")
	}
	if err := readJSON(filepath.Join(ag.stateDir, "commands.json"), &ag.journal); err != nil {
		t.Fatal(err)
	}
	if err := ag.commands(context.Background()); err != nil {
		t.Fatal(err)
	}
	if ag.pool.snapshot()[0].ID != worker || acks != 2 {
		t.Fatal("replayed durable command")
	}
	// A later heartbeat must not overwrite an explicit stop.
	ag.pool.lifecycle("stop")
	ag.pool.recoverDesired("running")
	if len(ag.pool.snapshot()) != 0 {
		t.Fatal("desired_state overwrote command")
	}
}

func TestRealHookCounterAndSanitizedPanic(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := &Pool{ctx: ctx, hook: func(context.Context, string, Config) (bool, error) { return true, nil }}
	p.configure(Config{Workers: 1})
	p.lifecycle("start")
	defer p.lifecycle("stop")
	deadline := time.Now().Add(3 * time.Second)
	for p.snapshot()[0].Tasks == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if p.snapshot()[0].Tasks == 0 {
		t.Fatal("real hook did not increment task count")
	}
	_, err := safeHook(func(context.Context, string, Config) (bool, error) { panic("secret") }, ctx, "id", Config{})
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatal("unsafe panic reporting")
	}
}

func backupTest(t *testing.T) *BackupManager {
	t.Helper()
	root := t.TempDir()
	source := filepath.Join(root, "code")
	runtime := filepath.Join(source, "runtime")
	state := filepath.Join(source, "state")
	for _, p := range []string{runtime, state} {
		if err := privateDir(p); err != nil {
			t.Fatal(err)
		}
	}
	return &BackupManager{source: source, runtimeDir: runtime, stateDir: state, tempDir: t.TempDir(), max: 1 << 20, state: BackupState{Requests: map[string]string{}}}
}
func archiveEntries(t *testing.T, path string) map[string]*tar.Header {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	entries := map[string]*tar.Header{}
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		entries[h.Name] = h
	}
	return entries
}

func TestArchiveExclusionsSymlinksBoundsCancellation(t *testing.T) {
	b := backupTest(t)
	writeTest(t, filepath.Join(b.source, "app.go"), []byte("code"))
	writeTest(t, filepath.Join(b.source, ".env"), []byte("included intentionally"))
	writeTest(t, filepath.Join(b.runtimeDir, "secret"), []byte("excluded"))
	writeTest(t, filepath.Join(b.stateDir, "secret"), []byte("excluded"))
	if err := os.Symlink("/etc/passwd", filepath.Join(b.source, "link")); err != nil {
		t.Fatal(err)
	}
	path, err := b.archive(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	entries := archiveEntries(t, path)
	if len(entries) != 3 || entries["app.go"] == nil || entries[".env"] == nil || entries["link"].Typeflag != tar.TypeSymlink || entries["link"].Linkname != "/etc/passwd" {
		t.Fatalf("unexpected entries %#v", entries)
	}
	fi, _ := os.Stat(path)
	if fi.Mode().Perm() != 0600 {
		t.Fatal("archive not private")
	}
	b.max = 2
	if _, err := b.archive(context.Background()); err == nil {
		t.Fatal("archive size guard missing")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := b.archive(ctx); err == nil {
		t.Fatal("archive ignored cancellation")
	}
	files, _ := os.ReadDir(b.tempDir)
	if len(files) != 1 {
		t.Fatalf("failed archive leaked temp files: %d", len(files))
	}
}

func TestArchiveRuntimeEqualsCodebase(t *testing.T) {
	b := backupTest(t)
	b.runtimeDir = b.source
	b.stateDir = b.source
	writeTest(t, filepath.Join(b.source, "main.go"), []byte("code"))
	for _, name := range []string{"config.json", "proxies.txt", ".sync.json", "backup-config.json", "commands.json", "backup-state.json"} {
		writeTest(t, filepath.Join(b.source, name), []byte("private"))
	}
	path, err := b.archive(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	entries := archiveEntries(t, path)
	if entries["main.go"] == nil {
		t.Fatal("excluded codebase")
	}
	if entries["config.json"] != nil || entries["backup-state.json"] != nil {
		t.Fatal("included managed files")
	}
}

func TestUploadAnyFileAndAcceptance(t *testing.T) {
	id := uuid()
	payload := []byte{0, 1, 255, 3}
	count := 0
	a := apiTest(t, func(w http.ResponseWriter, r *http.Request) {
		count++
		if r.URL.Path != "/api/agent/backups/upload" || r.Header.Get("Content-Type") != "application/octet-stream" {
			t.Error("wrong upload API")
		}
		if r.URL.Query().Get("filename") != "anything.bin" || r.URL.Query().Get("source") != "on_demand" || r.URL.Query().Get("request_id") != id {
			t.Error("wrong upload query")
		}
		got, _ := io.ReadAll(r.Body)
		if !bytes.Equal(got, payload) {
			t.Error("not raw binary upload")
		}
		w.WriteHeader(201)
	})
	path := filepath.Join(t.TempDir(), "data")
	writeTest(t, path, payload)
	if err := a.UploadFile(context.Background(), path, "anything.bin", "on_demand", id, 100); err != nil {
		t.Fatal(err)
	}
	payload = nil
	writeTest(t, path, nil)
	if err := a.UploadFile(context.Background(), path, "anything.bin", "on_demand", id, 100); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatal("empty file not uploaded")
	}
	if err := a.UploadFile(context.Background(), path, "../bad", "direct", "", 100); err == nil {
		t.Fatal("unsafe filename accepted")
	}
	if err := a.UploadFile(context.Background(), path, "ok", "on_demand", "", 100); err == nil {
		t.Fatal("missing request id accepted")
	}
}

func TestBackupPersistsAcceptedAndAmbiguousOutcomes(t *testing.T) {
	b := backupTest(t)
	writeTest(t, filepath.Join(b.source, "code"), []byte("ok"))
	id := uuid()
	b.api = apiTest(t, func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); w.WriteHeader(201) })
	if err := b.perform(context.Background(), id, "on_demand"); err != nil {
		t.Fatal(err)
	}
	var state BackupState
	if err := readJSON(filepath.Join(b.stateDir, "backup-state.json"), &state); err != nil {
		t.Fatal(err)
	}
	if state.Requests[id] != "accepted" || state.LastUpload.IsZero() {
		t.Fatal("accepted state not durable")
	}
	uncertain := uuid()
	b.api = apiTest(t, func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); w.WriteHeader(503) })
	if err := b.perform(context.Background(), uncertain, "on_demand"); err == nil {
		t.Fatal("expected ambiguous upload")
	}
	if b.state.Requests[uncertain] != "uncertain" || b.state.Requests[id] != "accepted" {
		t.Fatal("lost accepted outcome or falsely failed ambiguous upload")
	}
	files, _ := os.ReadDir(b.tempDir)
	if len(files) != 0 {
		t.Fatal("upload temp archive leaked")
	}
}

func TestBackupConfigPublicationAndPeriodicOffRequest(t *testing.T) {
	b := backupTest(t)
	writeTest(t, filepath.Join(b.source, "code"), []byte("ok"))
	id := uuid()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var mu sync.Mutex
	uploaded := false
	status := false
	b.api = apiTest(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agent/backup-config":
			w.Write([]byte(`{"enabled":false,"interval_minutes":15,"destination_ids":["target"],"agent_configured":false,"unexpected_secret":"discard"}`))
		case "/api/agent/backup-status":
			var raw map[string]any
			_ = json.NewDecoder(r.Body).Decode(&raw)
			if raw["configured"] != true || raw["next_backup_at"] != nil {
				t.Error("incorrect backup capability status")
			}
			mu.Lock()
			status = true
			mu.Unlock()
			w.Write([]byte(`{}`))
		case "/api/agent/backup-requests":
			json.NewEncoder(w).Encode([]BackupRequest{{ID: id, Status: "delivered"}})
		case "/api/agent/backups/upload":
			io.Copy(io.Discard, r.Body)
			mu.Lock()
			uploaded = true
			mu.Unlock()
			w.WriteHeader(201)
		default:
			t.Errorf("unexpected backup API: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	})
	done := make(chan struct{})
	go func() { defer close(done); b.run(ctx) }()
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		ok := uploaded
		mu.Unlock()
		if ok {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	mu.Lock()
	defer mu.Unlock()
	if !uploaded || !status {
		t.Fatal("on-demand backup failed with periodic off")
	}
	path := filepath.Join(b.runtimeDir, "backup-config.json")
	var got BackupConfig
	if err := readJSON(path, &got); err != nil {
		t.Fatal(err)
	}
	if got.Enabled || got.Interval != 15 || !reflect.DeepEqual(got.Destinations, []string{"target"}) {
		t.Fatal("incorrect backup-config snapshot")
	}
	if bytes.Contains(readTest(t, path), []byte("unexpected_secret")) {
		t.Fatal("unrecognized secrets published")
	}
	fi, _ := os.Stat(path)
	if fi.Mode().Perm() != 0600 {
		t.Fatal("backup config not private")
	}
}

func TestUncertainBackupOnlyReconcilesNeverFailsOrReuploads(t *testing.T) {
	for _, present := range []bool{true, false} {
		t.Run(map[bool]string{true: "still-delivered", false: "terminal"}[present], func(t *testing.T) {
			b := backupTest(t)
			id := uuid()
			b.state.Requests[id] = "uncertain"
			b.state.Attempts = map[string]BackupAttempt{id: {Count: 1, Ambiguous: true, NextRetry: time.Now().Add(time.Minute)}}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			b.api = apiTest(t, func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/agent/backup-config":
					w.Write([]byte(`{"enabled":false,"interval_minutes":15}`))
				case "/api/agent/backup-status":
					w.Write([]byte(`{}`))
				case "/api/agent/backup-requests":
					requests := []BackupRequest{}
					if present {
						requests = append(requests, BackupRequest{ID: id, Status: "delivered"})
					}
					json.NewEncoder(w).Encode(requests)
					// Stop after the response has reached the caller, without a second tick.
				default:
					t.Errorf("uncertain upload unexpectedly retried or failed: %s", r.URL.Path)
					w.WriteHeader(500)
				}
			})
			done := make(chan struct{})
			go func() { defer close(done); b.run(ctx) }()
			// Observe durable reconciliation rather than racing on in-memory state.
			deadline := time.Now().Add(3 * time.Second)
			want := "uncertain"
			if !present {
				want = "resolved"
			}
			for time.Now().Before(deadline) {
				var state BackupState
				if readJSON(filepath.Join(b.stateDir, "backup-state.json"), &state) == nil && state.Requests[id] == want {
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
			cancel()
			<-done
			if b.state.Requests[id] != want || !b.state.LastUpload.IsZero() {
				t.Fatal("ambiguous outcome falsely claimed successful or failed")
			}
		})
	}
}
