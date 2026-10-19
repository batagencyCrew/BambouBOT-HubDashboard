package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Proxy struct {
	ID       string `json:"id"`
	URL      string `json:"url"`
	Username string `json:"username"`
	Password string `json:"password"`
}
type Config struct {
	Workers     int     `json:"number_of_workers"`
	Preset      string  `json:"ai_preset_id"`
	Key         string  `json:"ai_api_key"`
	Revision    int64   `json:"revision"`
	Initialized bool    `json:"local_sync_initialized"`
	Proxies     []Proxy `json:"proxies"`
}
type checkpoint struct {
	Initialized bool  `json:"initialized"`
	Revision    int64 `json:"revision"`
}

func privateDir(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	fi, err := os.Lstat(path)
	if err != nil || !fi.IsDir() || fi.Mode()&os.ModeSymlink != 0 {
		return errors.New("runtime directory must not be a symlink")
	}
	return os.Chmod(path, 0700)
}

func atomicWrite(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".publish-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	defer f.Close()
	if err = f.Chmod(0600); err != nil {
		return err
	}
	if _, err = f.Write(data); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = os.Rename(name, path); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func saveJSON(path string, value any) error {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(path, append(b, '\n'))
}

func readJSON(path string, value any) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, (4<<20)+1))
	if err != nil || len(b) > 4<<20 {
		return errors.New("local JSON exceeds size limit or cannot be read")
	}
	d := json.NewDecoder(bytes.NewReader(b))
	if err := d.Decode(value); err != nil {
		return errors.New("invalid local JSON")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return errors.New("invalid trailing local JSON")
	}
	return nil
}

func proxyURL(p Proxy) (string, error) {
	u, err := url.Parse(p.URL)
	if err != nil || u.User != nil || u.Hostname() == "" || u.Port() == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("invalid proxy URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "socks5" {
		return "", errors.New("invalid proxy scheme")
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return "", errors.New("invalid proxy port")
	}
	u.Path = ""
	if p.Username != "" || p.Password != "" {
		u.User = url.UserPassword(p.Username, p.Password)
	}
	return u.String(), nil
}

func publishConfig(dir string, c Config) error {
	if c.Workers < 0 || c.Workers > 100 || c.Revision < 0 || len(c.Proxies) > 1000 {
		return errors.New("invalid hub configuration")
	}
	var lines strings.Builder
	for _, p := range c.Proxies {
		line, err := proxyURL(p)
		if err != nil {
			return err
		}
		lines.WriteString(line + "\n")
	}
	// Preserve arbitrary local fields without ever adding them to enrollment.
	local := map[string]json.RawMessage{}
	err := readJSON(filepath.Join(dir, "config.json"), &local)
	if err != nil && !os.IsNotExist(err) || local == nil {
		return errors.New("invalid local configuration; files preserved")
	}
	for key, value := range map[string]any{"ai_api_key": c.Key, "number_of_workers": c.Workers, "ai_preset_id": c.Preset, "revision": c.Revision} {
		b, err := json.Marshal(value)
		if err != nil {
			return err
		}
		local[key] = b
	}
	if err := saveJSON(filepath.Join(dir, "config.json"), local); err != nil {
		return err
	}
	if err := atomicWrite(filepath.Join(dir, "proxies.txt"), []byte(lines.String())); err != nil {
		return err
	}
	return saveJSON(filepath.Join(dir, ".sync.json"), checkpoint{true, c.Revision})
}

// Missing seed files are optional. Existing runtime files take precedence, enabling
// first enrollment simply by placing config.json / proxies.txt in runtime.
func localSeed(dir, configPath, proxyPath string) (map[string]any, error) {
	result := map[string]any{}
	cp := filepath.Join(dir, "config.json")
	if _, err := os.Stat(cp); os.IsNotExist(err) {
		cp = configPath
	}
	var raw map[string]json.RawMessage
	err := readJSON(cp, &raw)
	if err == nil {
		if raw == nil {
			return nil, errors.New("local config must be an object")
		}
		config := map[string]any{}
		for _, key := range []string{"ai_api_key", "ai_preset_id", "number_of_workers"} {
			if b, ok := raw[key]; ok {
				if key == "number_of_workers" {
					var n int
					if string(b) == "null" || json.Unmarshal(b, &n) != nil || n < 0 || n > 100 {
						return nil, errors.New("invalid local worker count")
					}
					config[key] = n
				} else {
					var s string
					if string(b) == "null" || json.Unmarshal(b, &s) != nil {
						return nil, errors.New("invalid local config field")
					}
					config[key] = s
				}
			}
		}
		result["config"] = config
	} else if !os.IsNotExist(err) {
		return nil, errors.New("cannot read local config")
	}
	pp := filepath.Join(dir, "proxies.txt")
	if _, err := os.Stat(pp); os.IsNotExist(err) {
		pp = proxyPath
	}
	f, err := os.Open(pp)
	if err == nil {
		defer f.Close()
		b, err := io.ReadAll(io.LimitReader(f, (2<<20)+1))
		if err != nil || len(b) > 2<<20 {
			return nil, errors.New("invalid local proxy file")
		}
		result["proxies_content"] = string(b) // Server validates/imports atomically, including comments and blank lines.
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("cannot read local proxy file")
	}
	return result, nil
}
