package main

import (
	"context"
	"errors"
	"math"
	"net/http"
)

// Statistics is the hub's latest whole-site snapshot. Nil metrics mean unknown.
type Statistics struct {
	SiteID                 string   `json:"site_id"`
	LinksSentSuccessfully  *int64   `json:"links_sent_successfully"`
	AverageMessagesPerChat *float64 `json:"average_messages_per_chat"`
	UpdatedAt              *string  `json:"updated_at"`
}

// ReportStatistics explicitly replaces both whole-site metrics. It never aggregates
// worker events or reports automatically. A nil average is sent as JSON null.
// Typed arguments exclude booleans and noninteger counters at compile time.
func (a *API) ReportStatistics(ctx context.Context, linksSentSuccessfully int64, averageMessagesPerChat *float64) (Statistics, error) {
	var result Statistics
	if linksSentSuccessfully < 0 || linksSentSuccessfully > 9007199254740991 {
		return result, errors.New("links_sent_successfully must be a nonnegative safe integer")
	}
	if averageMessagesPerChat != nil {
		average := *averageMessagesPerChat
		if math.IsNaN(average) || math.IsInf(average, 0) || average < 0 || average > 1000000000 {
			return result, errors.New("average_messages_per_chat must be null or finite in [0, 1000000000]")
		}
	}
	payload := struct {
		LinksSentSuccessfully  int64    `json:"links_sent_successfully"`
		AverageMessagesPerChat *float64 `json:"average_messages_per_chat"`
	}{linksSentSuccessfully, averageMessagesPerChat}
	err := a.json(ctx, http.MethodPost, "/statistics", payload, &result)
	return result, err
}
