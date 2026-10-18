package main

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestReportStatistics(t *testing.T) {
	calls := 0
	var payload map[string]json.RawMessage
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "POST" || r.URL.Path != "/api/agent/statistics" || r.Header.Get("Authorization") != "Bearer site-token" {
			t.Error("incorrect statistics request")
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"site_id":"site","links_sent_successfully":0,"average_messages_per_chat":null,"updated_at":null}`))
	}))
	defer server.Close()
	api, err := newAPI(server.URL, "site-token")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		links                  int64
		average                *float64
		wantLinks, wantAverage string
	}{
		{0, nil, "0", "null"},
		{0, statisticsFloat(0), "0", "0"},
		{9007199254740991, statisticsFloat(1000000000), "9007199254740991", "1000000000"},
		{12, statisticsFloat(2.5), "12", "2.5"},
	} {
		result, err := api.ReportStatistics(context.Background(), tc.links, tc.average)
		if err != nil || result.SiteID != "site" || result.AverageMessagesPerChat != nil {
			t.Fatalf("unexpected result: %+v, %v", result, err)
		}
		if len(payload) != 2 || string(payload["links_sent_successfully"]) != tc.wantLinks || string(payload["average_messages_per_chat"]) != tc.wantAverage {
			t.Fatalf("incorrect snapshot: %s", payload)
		}
	}
	if calls != 4 {
		t.Fatalf("calls = %d", calls)
	}
}

func statisticsFloat(value float64) *float64 { return &value }

func TestInvalidStatisticsNeverCallsAPI(t *testing.T) {
	// No client: any attempt to send invalid data would panic.
	api := &API{}
	for _, links := range []int64{-1, 9007199254740992, math.MaxInt64} {
		if _, err := api.ReportStatistics(context.Background(), links, nil); err == nil {
			t.Fatal("accepted invalid counter")
		}
	}
	for _, average := range []float64{-1, math.NaN(), math.Inf(1), math.Inf(-1), 1000000000.1} {
		if _, err := api.ReportStatistics(context.Background(), 1, &average); err == nil {
			t.Fatal("accepted invalid average")
		}
	}
}
