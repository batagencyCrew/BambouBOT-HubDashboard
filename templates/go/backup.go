package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode"
)

type BackupConfig struct {
	Enabled      bool     `json:"enabled"`
	Interval     int      `json:"interval_minutes"`
	Destinations []string `json:"destination_ids"`
	Configured   bool     `json:"agent_configured"`
	LastSeen     *string  `json:"agent_last_seen"`
	Next         *string  `json:"next_backup_at"`
}
type BackupRequest struct {
	ID       string  `json:"id"`
	Status   string  `json:"status"`
	BackupID *string `json:"backup_id"`
}
type BackupAttempt struct {
	Count     int       `json:"count"`
	NextRetry time.Time `json:"next_retry"`
	Ambiguous bool      `json:"ambiguous"`
	Warned    bool      `json:"warned"`
}
type BackupState struct {
	LastUpload  time.Time `json:"last_upload"`
	LastAttempt time.Time `json:"last_attempt"`
	// uncertain means upload may already be accepted; never send a failed ack.
	Requests map[string]string        `json:"requests"`
	Attempts map[string]BackupAttempt `json:"attempts"`
}
type BackupManager struct {
	api                                   *API
	runtimeDir, stateDir, source, tempDir string
	max                                   int64
	state                                 BackupState
}

func nested(path, root string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func newBackup(api *API, runtimeDir, stateDir string) (*BackupManager, error) {
	max, err := strconv.ParseInt(env("HUB_BACKUP_MAX_BYTES", "1073741824"), 10, 64)
	if err != nil || max < 1 {
		return nil, errors.New("HUB_BACKUP_MAX_BYTES must be positive")
	}
	b := &BackupManager{api: api, runtimeDir: runtimeDir, stateDir: stateDir, max: max, state: BackupState{Requests: map[string]string{}}}
	if source := os.Getenv("HUB_BACKUP_DIR"); source != "" {
		b.source, err = filepath.EvalSymlinks(source)
		if err != nil {
			return nil, errors.New("backup source is unavailable")
		}
		b.source, err = filepath.Abs(b.source)
		if err != nil {
			return nil, errors.New("invalid backup source")
		}
		fi, err := os.Stat(b.source)
		if err != nil || !fi.IsDir() {
			return nil, errors.New("backup source must be a directory")
		}
	}
	b.tempDir = env("HUB_BACKUP_TEMP_DIR", os.TempDir())
	b.tempDir, err = filepath.EvalSymlinks(b.tempDir)
	if err != nil {
		return nil, errors.New("backup temporary directory must exist")
	}
	b.tempDir, err = filepath.Abs(b.tempDir)
	if err != nil {
		return nil, errors.New("invalid backup temporary directory")
	}
	if b.source != "" && nested(b.tempDir, b.source) {
		return nil, errors.New("backup temporary directory must be outside source")
	}
	err = readJSON(filepath.Join(stateDir, "backup-state.json"), &b.state)
	if err != nil && !os.IsNotExist(err) {
		return nil, errors.New("invalid backup state; refusing unsafe replay")
	}
	if b.state.Requests == nil {
		return nil, errors.New("invalid backup state")
	}
	for id, status := range b.state.Requests {
		if !validID(id) || (status != "uncertain" && status != "accepted" && status != "failed" && status != "resolved") {
			return nil, errors.New("invalid backup state")
		}
	}
	if b.state.Attempts == nil {
		b.state.Attempts = map[string]BackupAttempt{}
	}
	for id, attempt := range b.state.Attempts {
		if !validID(id) || attempt.Count < 0 || attempt.Count > 3 {
			return nil, errors.New("invalid backup retry journal")
		}
	}
	// Legacy uncertain records have no attempt count. Treat them conservatively
	// as one ambiguous attempt, rather than resetting the persistent retry limit.
	for id, status := range b.state.Requests {
		if status == "uncertain" && b.state.Attempts[id].Count == 0 {
			b.state.Attempts[id] = BackupAttempt{Count: 1, Ambiguous: true, NextRetry: time.Now().UTC().Add(30 * time.Second)}
		}
	}
	return b, nil
}

func (b *BackupManager) save() error {
	return saveJSON(filepath.Join(b.stateDir, "backup-state.json"), b.state)
}

type boundedWriter struct {
	w         io.Writer
	remaining int64
}

func (w *boundedWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > w.remaining {
		return 0, errors.New("archive exceeds local size limit")
	}
	n, err := w.w.Write(p)
	w.remaining -= int64(n)
	return n, err
}

type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.r.Read(p)
}

func (b *BackupManager) excluded(path string) bool {
	for _, root := range []string{b.runtimeDir, b.stateDir, b.tempDir} {
		if root != b.source && nested(path, root) {
			return true
		}
	}
	// Runtime/state may deliberately be the script root. Exclude only owned
	// artifacts in that case, not the codebase itself.
	if filepath.Dir(path) == b.runtimeDir {
		switch filepath.Base(path) {
		case "config.json", "proxies.txt", ".sync.json", "backup-config.json":
			return true
		}
		if strings.HasPrefix(filepath.Base(path), ".publish-") {
			return true
		}
	}
	if filepath.Dir(path) == b.stateDir {
		switch filepath.Base(path) {
		case "commands.json", "backup-state.json":
			return true
		}
		if strings.HasPrefix(filepath.Base(path), ".publish-") {
			return true
		}
	}
	return false
}

// archive never follows symbolic links, never buffers the archive in RAM and
// bounds both the uncompressed file bytes and the compressed artifact size.
func (b *BackupManager) archive(ctx context.Context) (name string, err error) {
	f, err := os.CreateTemp(b.tempDir, "hub-backup-*.tar.gz")
	if err != nil {
		return "", errors.New("cannot create backup temporary file")
	}
	name = f.Name()
	defer func() {
		f.Close()
		if err != nil {
			os.Remove(name)
		}
	}()
	if err = f.Chmod(0600); err != nil {
		return name, err
	}
	gz := gzip.NewWriter(&boundedWriter{f, b.max})
	tw := tar.NewWriter(gz)
	var total int64
	err = filepath.WalkDir(b.source, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return errors.New("cannot read source tree")
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if path == b.source {
			return nil
		}
		if b.excluded(path) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return errors.New("cannot stat source entry")
		}
		mode := info.Mode()
		if !mode.IsRegular() && !mode.IsDir() && mode&os.ModeSymlink == 0 {
			return nil
		} // sockets/devices/FIFOs are not opened.
		link := ""
		if mode&os.ModeSymlink != 0 {
			link, err = os.Readlink(path)
			if err != nil {
				return errors.New("cannot read source link")
			}
		}
		h, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(b.source, path)
		if err != nil {
			return err
		}
		h.Name = filepath.ToSlash(rel)
		if mode.IsDir() {
			h.Name += "/"
		}
		if mode.IsRegular() {
			if info.Size() > b.max-total {
				return errors.New("source exceeds local size limit")
			}
			total += info.Size()
		}
		if err = tw.WriteHeader(h); err != nil {
			return err
		}
		if mode.IsRegular() {
			fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
			if err != nil {
				return errors.New("cannot open source file")
			}
			file := os.NewFile(uintptr(fd), path)
			defer file.Close()
			current, err := file.Stat()
			if err != nil || !current.Mode().IsRegular() || !os.SameFile(info, current) {
				return errors.New("source tree changed during backup")
			}
			_, err = io.CopyN(tw, contextReader{ctx, file}, info.Size())
			if err != nil {
				return err
			}
		}
		return nil
	})
	if closeErr := tw.Close(); err == nil {
		err = closeErr
	}
	if closeErr := gz.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	return name, err
}

func (a *API) uploadFile(ctx context.Context, path, filename, source, requestID string, max int64) error {
	if filename == "" || len(filename) > 200 || filename == "." || filename == ".." || strings.ContainsAny(filename, "/\\") || strings.ContainsFunc(filename, unicode.IsControl) {
		return errors.New("invalid upload filename")
	}
	if source != "direct" && source != "scheduled" && source != "on_demand" {
		return errors.New("invalid upload source")
	}
	if (source == "on_demand" && requestID == "") || (requestID != "" && !validID(requestID)) {
		return errors.New("invalid upload request identifier")
	}
	f, err := os.Open(path)
	if err != nil {
		return errors.New("cannot open upload file")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > max {
		return errors.New("invalid or oversized upload file")
	}
	q := url.Values{"filename": {filename}, "source": {source}}
	if requestID != "" {
		q.Set("request_id", requestID)
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	return a.request(ctx, "POST", "/backups/upload?"+q.Encode(), io.LimitReader(f, info.Size()), info.Size(), "application/octet-stream", nil)
}

func (b *BackupManager) perform(ctx context.Context, id, source string) error {
	if b.state.Attempts == nil {
		b.state.Attempts = map[string]BackupAttempt{}
	}
	previousAmbiguous := false
	if id != "" {
		attempt := b.state.Attempts[id]
		if attempt.Count >= 3 {
			return errors.New("backup upload retry limit reached")
		}
		previousAmbiguous = attempt.Ambiguous
		attempt.Count++
		attempt.NextRetry = time.Now().UTC().Add(time.Duration(30*(1<<(attempt.Count-1))) * time.Second)
		b.state.Attempts[id] = attempt
		b.state.Requests[id] = "uncertain"
		if b.save() != nil {
			return errors.New("cannot persist backup retry attempt")
		}
	}
	// Building failure is known not to have reached the hub, so a failed ack is safe.
	path, err := b.archive(ctx)
	if err != nil {
		if id != "" && ctx.Err() == nil && !previousAmbiguous {
			b.state.Requests[id] = "failed"
			if b.save() != nil {
				return errors.New("cannot persist backup failure")
			}
		}
		return errors.New("archive creation failed")
	}
	defer os.Remove(path)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if id != "" {
		b.state.Requests[id] = "uncertain"
		attempt := b.state.Attempts[id]
		attempt.Ambiguous = true
		b.state.Attempts[id] = attempt
	}
	b.state.LastAttempt = time.Now().UTC()
	if err = b.save(); err != nil {
		return errors.New("cannot persist backup attempt")
	}
	err = b.api.UploadFile(ctx, path, "code-"+time.Now().UTC().Format("20060102T150405Z")+".tar.gz", source, id, b.max)
	if err != nil {
		var status *HTTPError
		if id != "" && errors.As(err, &status) && definiteRejection(status.Status) && !previousAmbiguous {
			// A definite rejection is not an accepted upload. Still require a fresh
			// queue read before sending a failure ack, never infer from this response alone.
			b.state.Requests[id] = "failed"
			attempt := b.state.Attempts[id]
			attempt.Ambiguous = false
			b.state.Attempts[id] = attempt
			if b.save() != nil {
				return errors.New("cannot persist rejected backup outcome")
			}
			return errors.New("hub rejected backup upload; awaiting queue confirmation")
		}
		// The request may have committed before a disconnect/timeout. Preserve the
		// uncertain journal and reconcile the request queue; never send failed ack.
		return errors.New("upload outcome uncertain; retained for reconciliation")
	}
	b.state.LastUpload = time.Now().UTC()
	if id != "" {
		b.state.Requests[id] = "accepted"
	}
	if b.save() != nil {
		return errors.New("upload accepted but timestamp persistence failed")
	}
	return nil
}

func definiteRejection(status int) bool {
	switch status {
	case 400, 401, 403, 404, 405, 411, 413, 414, 415, 422, 429:
		return true
	}
	return false // 409, timeouts and server errors can race with an accepted upload.
}

func (b *BackupManager) pollRequests(ctx context.Context) error {
	var requests []BackupRequest
	if err := b.api.json(ctx, "GET", "/backup-requests", nil, &requests); err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, request := range requests {
		if !validID(request.ID) {
			return errors.New("invalid backup request identifier")
		}
		id := request.ID
		seen[id] = true
		if request.BackupID != nil || request.Status == "uploaded" {
			b.state.Requests[id] = "accepted"
			continue
		}
		if request.Status != "delivered" {
			continue
		} // The hub marks pending requests delivered on GET.
		status := b.state.Requests[id]
		attempt := b.state.Attempts[id]
		switch status {
		case "accepted", "resolved":
			continue
		case "failed":
			if attempt.Ambiguous {
				continue
			}
			if b.save() != nil {
				return errors.New("cannot persist backup failure")
			}
			if err := b.api.json(ctx, "POST", "/backup-requests/"+id+"/ack", Outcome{"failed", "local archive unavailable or hub rejected upload; check source and upload limits"}, nil); err != nil {
				return err
			}
			b.state.Requests[id] = "resolved"
			continue
		case "uncertain":
			if attempt.Count >= 3 {
				if !attempt.Warned {
					message := "Backup request " + id + ": upload outcome uncertain after three attempts; inspect hub backup history and resolve request before requesting another backup."
					log.Print(message)
					if err := b.api.json(ctx, "POST", "/errors", map[string]string{"level": "warning", "message": message}, nil); err != nil {
						return err
					}
					attempt.Warned = true
					b.state.Attempts[id] = attempt
				}
				continue
			}
			if time.Now().Before(attempt.NextRetry) {
				continue
			}
		}
		if b.source == "" {
			continue
		}
		// This fresh queue snapshot confirms delivered + no backup_id before a
		// bounded retry using the SAME request ID. Hub acceptance makes it vanish
		// from subsequent polls. This remains at-least-once, not exactly-once.
		if err := b.perform(ctx, id, "on_demand"); err != nil && ctx.Err() == nil {
			log.Print(err)
		}
	}
	for id, status := range b.state.Requests {
		if !seen[id] && (status == "uncertain" || status == "failed") {
			b.state.Requests[id] = "resolved"
		}
	}
	if b.save() != nil {
		return errors.New("cannot persist reconciled backup outcomes")
	}
	return nil
}

func (b *BackupManager) run(ctx context.Context) {
	var config BackupConfig
	var lastConfig time.Time
	loop(ctx, 5*time.Second, func(ctx context.Context) error {
		if time.Since(lastConfig) >= 30*time.Second {
			if err := b.api.json(ctx, "GET", "/backup-config", nil, &config); err != nil {
				return err
			}
			if config.Interval < 15 || config.Interval > 43200 {
				return errors.New("invalid backup interval")
			}
			if err := saveJSON(filepath.Join(b.runtimeDir, "backup-config.json"), config); err != nil {
				return errors.New("cannot publish safe backup configuration")
			}
			var next any
			if b.source != "" && config.Enabled {
				base := b.state.LastUpload
				if base.IsZero() {
					base = time.Now().UTC()
				}
				next = base.Add(time.Duration(config.Interval) * time.Minute).Format(time.RFC3339)
			}
			if err := b.api.json(ctx, "POST", "/backup-status", map[string]any{"configured": b.source != "", "next_backup_at": next}, nil); err != nil {
				return err
			}
			lastConfig = time.Now()
		}
		if err := b.pollRequests(ctx); err != nil {
			return err
		}
		base := b.state.LastUpload
		if b.state.LastAttempt.After(base) {
			base = b.state.LastAttempt
		}
		if b.source != "" && config.Enabled && (base.IsZero() || time.Since(base) >= time.Duration(config.Interval)*time.Minute) {
			// Rate-limit failures including archive creation errors.
			b.state.LastAttempt = time.Now().UTC()
			if b.save() != nil {
				return errors.New("cannot persist scheduled attempt")
			}
			return b.perform(ctx, "", "scheduled")
		}
		return nil
	})
}
