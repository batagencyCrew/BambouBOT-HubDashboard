package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type API struct {
	origin string
	token  string
	client *http.Client
}

type HTTPError struct{ Status int }

func (e *HTTPError) Error() string { return fmt.Sprintf("hub returned HTTP %d", e.Status) }

func newAPI(origin, token string) (*API, error) {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || strings.Contains(origin, "#") || (u.Path != "" && u.Path != "/") || u.Opaque != "" {
		return nil, errors.New("HUB_URL must be an HTTPS origin without credentials, path, query or fragment")
	}
	local := u.Hostname() == "localhost"
	if ip := net.ParseIP(u.Hostname()); ip != nil {
		local = ip.IsLoopback()
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return nil, errors.New("HUB_URL requires HTTPS (loopback HTTP is allowed for development)")
	}
	if strings.TrimSpace(token) == "" || strings.ContainsAny(token, "\r\n") {
		return nil, errors.New("HUB_AGENT_TOKEN is required")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 30 * time.Second
	transport.Proxy = nil // Never send the site bearer token through an environment-selected proxy.
	return &API{strings.TrimRight(origin, "/"), token, &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

func (a *API) request(ctx context.Context, method, path string, body io.Reader, size int64, contentType string, result any) error {
	req, err := http.NewRequestWithContext(ctx, method, a.origin+"/api/agent"+path, body)
	if err != nil {
		return errors.New("cannot construct hub request")
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if size >= 0 {
		req.ContentLength = size
	}
	resp, err := a.client.Do(req)
	if err != nil {
		return errors.New("hub transport failed or request canceled")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &HTTPError{resp.StatusCode}
	}
	if result != nil {
		if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(result); err != nil {
			return errors.New("invalid hub response")
		}
	}
	return nil
}

func (a *API) json(ctx context.Context, method, path string, body, result any) error {
	ctx, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	var r io.Reader
	var size int64 = 0
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return errors.New("cannot encode request")
		}
		r, size = bytes.NewReader(b), int64(len(b))
	}
	return a.request(ctx, method, path, r, size, "application/json", result)
}

// UploadFile streams any regular file, including empty files; no extension filter.
// The local path is never obtained from a hub response.
func (a *API) UploadFile(ctx context.Context, path, filename, source, requestID string, maxBytes int64) error {
	return a.uploadFile(ctx, path, filename, source, requestID, maxBytes)
}
