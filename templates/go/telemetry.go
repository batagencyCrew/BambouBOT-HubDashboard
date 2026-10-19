package main

import (
	"context"
	"errors"
	"math"
	"regexp"
)

// Reporting is explicitly invoked by trusted supervisor code.
type ChatEvent struct {
	EventID   string  `json:"event_id"`
	WorkerID  string  `json:"worker_id"`
	MsgsIn    int64   `json:"msgs_in"`
	MsgsOut   int64   `json:"msgs_out"`
	Links     int64   `json:"links"`
	Converted bool    `json:"converted"`
	Duration  float64 `json:"duration"`
	ProxyID   *string `json:"proxy_id,omitempty"`
	Room      *string `json:"room,omitempty"`
	Random    *bool   `json:"random,omitempty"`
}

type AIUsageEvent struct {
	EventID   string  `json:"event_id"`
	KeyID     string  `json:"key_id"`
	Calls     int64   `json:"calls"`
	Error429  int64   `json:"error_429"`
	Error502  int64   `json:"error_502"`
	LatencyMS float64 `json:"latency_ms"`
}

var telemetryLabel = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,80}$`)
var telemetryRoom = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var telemetrySecret = regexp.MustCompile(`(?i)(bbk_|sk_|sk-|bearer)`)

func validTelemetryLabel(s string) bool {
	return telemetryLabel.MatchString(s) && !telemetrySecret.MatchString(s)
}
func telemetryCount(n int64) bool         { return n >= 0 && n <= 9007199254740991 }
func telemetryMeasurement(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) && n >= 0 }

func (a *API) ReportChat(ctx context.Context, e ChatEvent) error {
	if !validID(e.EventID) || !validID(e.WorkerID) || !telemetryCount(e.MsgsIn) || !telemetryCount(e.MsgsOut) || !telemetryCount(e.Links) || !telemetryMeasurement(e.Duration) || e.Duration > 604800 || (e.ProxyID != nil && !validID(*e.ProxyID)) || (e.Room != nil && !telemetryRoom.MatchString(*e.Room)) {
		return errors.New("invalid chat telemetry")
	}
	return a.json(ctx, "POST", "/chats", e, nil)
}

func (a *API) ReportAIUsage(ctx context.Context, e AIUsageEvent) error {
	if !validID(e.EventID) || !validTelemetryLabel(e.KeyID) || !telemetryCount(e.Calls) || !telemetryCount(e.Error429) || !telemetryCount(e.Error502) || !telemetryMeasurement(e.LatencyMS) || e.Error429+e.Error502 > e.Calls || (e.Calls == 0 && e.LatencyMS != 0) {
		return errors.New("invalid AI usage telemetry")
	}
	return a.json(ctx, "POST", "/ai-usage", e, nil)
}

func (a *API) ReportProxyError(ctx context.Context, workerID, code string, proxyID *string) error {
	if !validID(workerID) || (proxyID != nil && !validID(*proxyID)) {
		return errors.New("invalid proxy telemetry UUID")
	}
	switch code {
	case "proxy_blocked", "proxy_auth", "proxy_timeout", "proxy_recovered", "other":
	default:
		return errors.New("invalid proxy error code")
	}
	payload := struct {
		WorkerID string  `json:"worker_id"`
		Level    string  `json:"level"`
		Message  string  `json:"message"`
		Code     string  `json:"code"`
		ProxyID  *string `json:"proxy_id,omitempty"`
	}{workerID, "error", "Proxy status event", code, proxyID}
	return a.json(ctx, "POST", "/errors", payload, nil)
}
