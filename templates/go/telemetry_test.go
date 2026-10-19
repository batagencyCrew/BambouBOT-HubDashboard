package main

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"reflect"
	"testing"
)

func TestExplicitTelemetryExactPayloads(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	room, random := "room-alias", false
	want := []struct{ path, body string }{
		{"/api/agent/chats", `{"event_id":"` + id + `","worker_id":"` + id + `","msgs_in":2,"msgs_out":3,"links":1,"converted":false,"duration":4.5,"proxy_id":"` + id + `","room":"room-alias","random":false}`},
		{"/api/agent/chats", `{"event_id":"` + id + `","worker_id":"` + id + `","msgs_in":2,"msgs_out":3,"links":1,"converted":false,"duration":4.5}`},
		{"/api/agent/ai-usage", `{"event_id":"` + id + `","key_id":"primary-alias","calls":5,"error_429":1,"error_502":0,"latency_ms":12.5}`},
		{"/api/agent/errors", `{"worker_id":"` + id + `","proxy_id":"` + id + `","code":"proxy_recovered","level":"error","message":"Proxy status event"}`},
	}
	index := 0
	api := apiTest(t, func(w http.ResponseWriter, r *http.Request) {
		if index >= len(want) {
			t.Error("unexpected request")
			w.WriteHeader(500)
			return
		}
		expected := want[index]
		index++
		var got, body any
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Error(err)
		}
		if err := json.Unmarshal([]byte(expected.body), &body); err != nil {
			t.Fatal(err)
		}
		if r.Method != "POST" || r.URL.Path != expected.path || !reflect.DeepEqual(got, body) {
			t.Error("unexpected telemetry payload")
		}
		w.Write([]byte(`{"accepted":true}`))
	})
	chat := ChatEvent{EventID: id, WorkerID: id, MsgsIn: 2, MsgsOut: 3, Links: 1, Converted: false, Duration: 4.5, ProxyID: &id, Room: &room, Random: &random}
	ctx := context.Background()
	if err := api.ReportChat(ctx, chat); err != nil {
		t.Fatal(err)
	}
	chat.ProxyID, chat.Room, chat.Random = nil, nil, nil
	if err := api.ReportChat(ctx, chat); err != nil {
		t.Fatal(err)
	}
	if err := api.ReportAIUsage(ctx, AIUsageEvent{EventID: id, KeyID: "primary-alias", Calls: 5, Error429: 1, LatencyMS: 12.5}); err != nil {
		t.Fatal(err)
	}
	if err := api.ReportProxyError(ctx, id, "proxy_recovered", &id); err != nil {
		t.Fatal(err)
	}
	if index != len(want) {
		t.Fatal("missing explicit requests")
	}
}

func TestInvalidTelemetryNeverRequests(t *testing.T) {
	api := apiTest(t, func(w http.ResponseWriter, r *http.Request) { t.Error("invalid payload sent"); w.WriteHeader(500) })
	id, bad := "11111111-1111-4111-8111-111111111111", "bad"
	base := ChatEvent{EventID: id, WorkerID: id}
	for _, change := range []func(*ChatEvent){
		func(e *ChatEvent) { e.EventID = bad }, func(e *ChatEvent) { e.ProxyID = &bad },
		func(e *ChatEvent) { e.MsgsIn = -1 }, func(e *ChatEvent) { e.Links = 9007199254740992 },
		func(e *ChatEvent) { e.Duration = math.Inf(1) }, func(e *ChatEvent) { e.Duration = 604801 }, func(e *ChatEvent) { room := "private@email.test"; e.Room = &room },
	} {
		e := base
		change(&e)
		if err := api.ReportChat(context.Background(), e); err == nil {
			t.Fatal("invalid chat accepted")
		}
	}
	for _, alias := range []string{"sk-private-secret", "slot-bbk_private", "Bearer private", "https://private"} {
		if err := api.ReportAIUsage(context.Background(), AIUsageEvent{EventID: id, KeyID: alias}); err == nil {
			t.Fatal("invalid alias accepted")
		}
	}
	if err := api.ReportAIUsage(context.Background(), AIUsageEvent{EventID: id, KeyID: "primary-alias", Calls: -1}); err == nil {
		t.Fatal("negative count accepted")
	}
	if err := api.ReportAIUsage(context.Background(), AIUsageEvent{EventID: id, KeyID: "primary-alias", Calls: 1, Error429: 1, Error502: 1}); err == nil {
		t.Fatal("invalid totals accepted")
	}
	if err := api.ReportAIUsage(context.Background(), AIUsageEvent{EventID: id, KeyID: "primary-alias", LatencyMS: 1}); err == nil {
		t.Fatal("zero calls with latency accepted")
	}
	if err := api.ReportAIUsage(context.Background(), AIUsageEvent{EventID: id, KeyID: "primary-alias", LatencyMS: math.NaN()}); err == nil {
		t.Fatal("NaN accepted")
	}
	if err := api.ReportProxyError(context.Background(), id, "raw upstream body", nil); err == nil {
		t.Fatal("invalid code accepted")
	}
}
