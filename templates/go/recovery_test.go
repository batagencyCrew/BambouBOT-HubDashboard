package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRestartRefreshPublishesBeforeActionAndAck(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "fresh-config", true: "failed-refresh"}[fail], func(t *testing.T) {
			var ag *Agent
			id := uuid()
			api := apiTest(t, func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/agent/config":
					if fail {
						w.WriteHeader(503)
						return
					}
					json.NewEncoder(w).Encode(Config{Workers: 2, Key: "", Preset: "new", Revision: 7, Initialized: true})
				case "/api/agent/commands":
					json.NewEncoder(w).Encode([]Command{{id, "restart"}})
				default:
					if !strings.HasSuffix(r.URL.Path, "/ack") {
						t.Errorf("unexpected path: %s", r.URL.Path)
						w.WriteHeader(404)
						return
					}
					var outcome Outcome
					_ = json.NewDecoder(r.Body).Decode(&outcome)
					if fail {
						if outcome.Status != "failed" || len(ag.pool.snapshot()) != 1 {
							t.Error("refresh failure performed restart")
						}
					} else {
						var c Config
						if err := readJSON(filepath.Join(ag.runtimeDir, "config.json"), &c); err != nil {
							t.Error(err)
						}
						if outcome.Status != "completed" || c.Workers != 2 || c.Key != "" || c.Revision != 7 || len(ag.pool.snapshot()) != 2 {
							t.Error("ack before fresh config/action")
						}
						if len(readTest(t, filepath.Join(ag.runtimeDir, "proxies.txt"))) != 0 {
							t.Error("deleted proxies not published before ack")
						}
					}
					w.Write([]byte(`{}`))
				}
			})
			ag = agentTest(t, api)
			old := Config{Workers: 1, Key: "old", Revision: 6, Initialized: true, Proxies: []Proxy{{URL: "http://old.example:8080"}}}
			if err := publishConfig(ag.runtimeDir, old); err != nil {
				t.Fatal(err)
			}
			ag.pool.configure(old)
			ag.pool.lifecycle("start")
			before := ag.pool.snapshot()[0].ID
			if err := ag.commands(context.Background()); err != nil {
				t.Fatal(err)
			}
			if fail && ag.pool.snapshot()[0].ID != before {
				t.Fatal("failed refresh replaced worker")
			}
			if !fail && ag.pool.snapshot()[0].ID == before {
				t.Fatal("restart did not replace worker")
			}
		})
	}
}

func forceRetry(b *BackupManager, id string) {
	if b.state.Attempts == nil {
		b.state.Attempts = map[string]BackupAttempt{}
	}
	a := b.state.Attempts[id]
	a.NextRetry = time.Now().Add(-time.Second)
	b.state.Attempts[id] = a
}

func TestDefiniteUpload413FailsOnlyAfterFreshQueueConfirmation(t *testing.T) {
	b := backupTest(t)
	id := uuid()
	uploads, acks, polls := 0, 0, 0
	b.api = apiTest(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agent/backup-requests":
			polls++
			json.NewEncoder(w).Encode([]BackupRequest{{ID: id, Status: "delivered"}})
		case "/api/agent/backups/upload":
			uploads++
			io.Copy(io.Discard, r.Body)
			w.WriteHeader(413)
		default:
			if !strings.HasSuffix(r.URL.Path, "/ack") {
				t.Errorf("unexpected API %s", r.URL.Path)
			}
			acks++
			if polls != 2 {
				t.Error("failed ack without fresh reconciliation")
			}
			w.Write([]byte(`{}`))
		}
	})
	if err := b.pollRequests(context.Background()); err != nil {
		t.Fatal(err)
	}
	if uploads != 1 || acks != 0 || b.state.Requests[id] != "failed" {
		t.Fatal("413 was not classified as definite nonacceptance")
	}
	if err := b.pollRequests(context.Background()); err != nil {
		t.Fatal(err)
	}
	if uploads != 1 || acks != 1 || b.state.Requests[id] != "resolved" {
		t.Fatal("definite rejected request left stranded")
	}
}

func loseResponse(t *testing.T, w http.ResponseWriter, r *http.Request) {
	t.Helper()
	io.Copy(io.Discard, r.Body)
	conn, _, err := w.(http.Hijacker).Hijack()
	if err != nil {
		t.Error(err)
		return
	}
	conn.Close()
}

func TestLostUploadResponseReconcilesBeforeBoundedRetry(t *testing.T) {
	for _, accepted := range []bool{false, true} {
		t.Run(map[bool]string{false: "retry-delivered", true: "accepted-response-lost"}[accepted], func(t *testing.T) {
			b := backupTest(t)
			id := uuid()
			uploads, acks := 0, 0
			b.api = apiTest(t, func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/agent/backup-requests":
					queue := []BackupRequest{}
					if !accepted || uploads == 0 {
						queue = append(queue, BackupRequest{ID: id, Status: "delivered"})
					}
					json.NewEncoder(w).Encode(queue)
				case "/api/agent/backups/upload":
					uploads++
					if uploads == 1 {
						loseResponse(t, w, r)
						return
					}
					io.Copy(io.Discard, r.Body)
					w.WriteHeader(201)
				default:
					acks++
					t.Errorf("lost response falsely acknowledged: %s", r.URL.Path)
					w.WriteHeader(500)
				}
			})
			if err := b.pollRequests(context.Background()); err != nil {
				t.Fatal(err)
			}
			if b.state.Requests[id] != "uncertain" || b.state.Attempts[id].Count != 1 {
				t.Fatal("lost response not journaled")
			}
			if !accepted {
				if err := b.pollRequests(context.Background()); err != nil {
					t.Fatal(err)
				}
				if uploads != 1 {
					t.Fatal("backoff ignored")
				}
			}
			forceRetry(b, id)
			if err := b.pollRequests(context.Background()); err != nil {
				t.Fatal(err)
			}
			if accepted {
				if uploads != 1 || b.state.Requests[id] != "resolved" || !b.state.LastUpload.IsZero() {
					t.Fatal("accepted upload repeated or fabricated timestamp")
				}
			} else if uploads != 2 || b.state.Requests[id] != "accepted" || b.state.LastUpload.IsZero() {
				t.Fatal("still-delivered request did not recover")
			}
			if acks != 0 {
				t.Fatal("ambiguous request falsely failed")
			}
		})
	}
}

func TestBackupRetryLimitSurvivesReloadAndWarnsWithoutFailureAck(t *testing.T) {
	b := backupTest(t)
	id := uuid()
	uploads, warnings, acks := 0, 0, 0
	b.api = apiTest(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agent/backup-requests":
			json.NewEncoder(w).Encode([]BackupRequest{{ID: id, Status: "delivered"}})
		case "/api/agent/backups/upload":
			uploads++
			loseResponse(t, w, r)
		case "/api/agent/errors":
			warnings++
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["level"] != "warning" || !strings.Contains(body["message"], id) {
				t.Error("warning not actionable")
			}
			w.Write([]byte(`{}`))
		default:
			acks++
			w.Write([]byte(`{}`))
		}
	})
	for i := 0; i < 3; i++ {
		forceRetry(b, id)
		if err := b.pollRequests(context.Background()); err != nil {
			t.Fatal(err)
		}
		var loaded BackupState
		if err := readJSON(filepath.Join(b.stateDir, "backup-state.json"), &loaded); err != nil {
			t.Fatal(err)
		}
		b.state = loaded
	}
	for i := 0; i < 2; i++ {
		forceRetry(b, id)
		if err := b.pollRequests(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if uploads != 3 || warnings != 1 || acks != 0 || b.state.Attempts[id].Count != 3 || b.state.Requests[id] != "uncertain" {
		t.Fatalf("bad persistent bound: uploads=%d warnings=%d acks=%d", uploads, warnings, acks)
	}
}

func TestLinkedBackupIDPreventsFailureAckOrRetry(t *testing.T) {
	b := backupTest(t)
	id, backupID := uuid(), uuid()
	b.state.Requests[id] = "failed"
	b.api = apiTest(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/backup-requests" {
			t.Error("linked upload was failed or repeated")
		}
		json.NewEncoder(w).Encode([]BackupRequest{{ID: id, Status: "delivered", BackupID: &backupID}})
	})
	if err := b.pollRequests(context.Background()); err != nil {
		t.Fatal(err)
	}
	if b.state.Requests[id] != "accepted" {
		t.Fatal("linked backup not preserved")
	}
}

func TestLaterDefiniteRejectionCannotFailEarlierAmbiguousAttempt(t *testing.T) {
	b := backupTest(t)
	id := uuid()
	uploads, acks := 0, 0
	b.api = apiTest(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agent/backup-requests":
			json.NewEncoder(w).Encode([]BackupRequest{{ID: id, Status: "delivered"}})
		case "/api/agent/backups/upload":
			uploads++
			if uploads == 1 {
				loseResponse(t, w, r)
				return
			}
			io.Copy(io.Discard, r.Body)
			w.WriteHeader(413)
		default:
			acks++
			w.Write([]byte(`{}`))
		}
	})
	for i := 0; i < 2; i++ {
		forceRetry(b, id)
		if err := b.pollRequests(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if err := b.pollRequests(context.Background()); err != nil {
		t.Fatal(err)
	}
	if uploads != 2 || acks != 0 || b.state.Requests[id] != "uncertain" || !b.state.Attempts[id].Ambiguous {
		t.Fatal("later rejection falsely failed potentially accepted earlier upload")
	}
}
