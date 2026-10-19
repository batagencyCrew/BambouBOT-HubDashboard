package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestGoDoesNotLoadDotEnv(t *testing.T) {
	dir := t.TempDir()
	writeTest(t, filepath.Join(dir, ".env"), []byte("HUB_URL=http://localhost:1\nHUB_AGENT_TOKEN=file-token\n"))
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chdir(old); err != nil {
			t.Error(err)
		}
	})
	t.Setenv("HUB_URL", "")
	t.Setenv("HUB_AGENT_TOKEN", "")
	if err := run(); err == nil {
		t.Fatal("missing exports unexpectedly accepted")
	}
	if os.Getenv("HUB_URL") != "" || os.Getenv("HUB_AGENT_TOKEN") != "" {
		t.Fatal("dotenv was loaded")
	}
}

func TestLocalExtrasPreservedWithoutDiscoveryOrUpload(t *testing.T) {
	c := Config{Workers: 0, Revision: 0}
	posts := 0
	api := apiTest(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			posts++
			want := map[string]any{"expected_revision": float64(c.Revision)}
			if posts == 1 {
				want["config"] = map[string]any{"ai_api_key": "seed", "number_of_workers": float64(2)}
			}
			if !reflect.DeepEqual(body, want) {
				t.Errorf("unexpected enrollment payload: %#v", body)
			}
			c.Revision++
			c.Initialized = true
		}
		json.NewEncoder(w).Encode(c)
	})
	a := agentTest(t, api)
	file := filepath.Join(a.runtimeDir, "config.json")
	writeTest(t, file, []byte(`{"password":"local-secret","nested":{"list":[true,null,3]},"large_id":9007199254740993,"ai_api_key":"seed","number_of_workers":2}`))
	writeTest(t, filepath.Join(a.runtimeDir, ".env"), []byte("SECRET=env-secret"))
	writeTest(t, filepath.Join(a.runtimeDir, "automation-settings.json"), []byte(`{"secret":"other-secret"}`))
	for i := 0; i < 3; i++ {
		if i == 2 {
			if err := os.Remove(filepath.Join(a.runtimeDir, ".sync.json")); err != nil {
				t.Fatal(err)
			}
		}
		if err := a.syncConfig(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if posts != 2 {
		t.Fatalf("unexpected enrollment count: %d", posts)
	}
	var saved map[string]json.RawMessage
	if err := readJSON(file, &saved); err != nil {
		t.Fatal(err)
	}
	for key, want := range map[string]string{"password": `"local-secret"`, "large_id": "9007199254740993", "ai_api_key": `""`, "number_of_workers": "0"} {
		if string(saved[key]) != want {
			t.Errorf("field %s changed: %s", key, saved[key])
		}
	}
	var nested any
	if err := json.Unmarshal(saved["nested"], &nested); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(nested, map[string]any{"list": []any{true, nil, float64(3)}}) {
		t.Fatal("nested extra changed")
	}
	fi, err := os.Stat(file)
	if err != nil || fi.Mode().Perm() != 0600 {
		t.Fatal("not private")
	}
}

func TestInvalidLocalJSONBlocksPublication(t *testing.T) {
	for _, invalid := range []string{`{secret`, `[]`, `null`, `"secret"`} {
		t.Run(invalid, func(t *testing.T) {
			dir := t.TempDir()
			originals := map[string]string{"config.json": invalid, "proxies.txt": "keep", ".sync.json": `{"initialized":true,"revision":1}`}
			for name, content := range originals {
				writeTest(t, filepath.Join(dir, name), []byte(content))
			}
			if err := publishConfig(dir, Config{Workers: 0, Revision: 2}); err == nil {
				t.Fatal("accepted invalid JSON")
			}
			for name, content := range originals {
				if string(readTest(t, filepath.Join(dir, name))) != content {
					t.Fatalf("changed %s", name)
				}
			}
		})
	}
}
