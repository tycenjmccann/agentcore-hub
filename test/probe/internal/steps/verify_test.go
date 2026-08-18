package steps

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/client"
)

func TestVerify_CompletesImmediately(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"id":         "exec-1",
			"routine_id": "routine-1",
			"status":     "completed",
		})
	}))
	defer srv.Close()

	c := client.NewRoutinesClient(srv.URL, "token", 5*time.Second)
	step := NewVerifyExecutionStep(c, 5*time.Second, 50*time.Millisecond)

	state := &RunState{
		RunID:       "test-run",
		RoutineID:   "routine-1",
		ExecutionID: "exec-1",
		StepResults: make(map[string]string),
	}

	result := step.Run(context.Background(), state)

	if result.Result != "pass" {
		t.Errorf("expected pass, got %s", result.Result)
	}
	if result.Error != nil {
		t.Errorf("expected no error, got %+v", result.Error)
	}
}

func TestVerify_CompletesAfterPolling(t *testing.T) {
	var callCount atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := callCount.Add(1)
		w.Header().Set("Content-Type", "application/json")
		status := "pending"
		if n >= 3 {
			status = "completed"
		}
		json.NewEncoder(w).Encode(map[string]string{
			"id":         "exec-1",
			"routine_id": "routine-1",
			"status":     status,
		})
	}))
	defer srv.Close()

	c := client.NewRoutinesClient(srv.URL, "token", 5*time.Second)
	step := NewVerifyExecutionStep(c, 5*time.Second, 50*time.Millisecond)

	state := &RunState{
		RunID:       "test-run",
		RoutineID:   "routine-1",
		ExecutionID: "exec-1",
		StepResults: make(map[string]string),
	}

	result := step.Run(context.Background(), state)

	if result.Result != "pass" {
		t.Errorf("expected pass, got %s", result.Result)
	}
	if callCount.Load() < 3 {
		t.Errorf("expected at least 3 polls, got %d", callCount.Load())
	}
}

func TestVerify_ExecutionFailed(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"id":         "exec-1",
			"routine_id": "routine-1",
			"status":     "failed",
		})
	}))
	defer srv.Close()

	c := client.NewRoutinesClient(srv.URL, "token", 5*time.Second)
	step := NewVerifyExecutionStep(c, 5*time.Second, 50*time.Millisecond)

	state := &RunState{
		RunID:       "test-run",
		RoutineID:   "routine-1",
		ExecutionID: "exec-1",
		StepResults: make(map[string]string),
	}

	result := step.Run(context.Background(), state)

	if result.Result != "fail" {
		t.Errorf("expected fail, got %s", result.Result)
	}
	if result.Error == nil {
		t.Fatal("expected error")
	}
	if result.Error.Code != "EXECUTION_FAILED" {
		t.Errorf("expected EXECUTION_FAILED, got %s", result.Error.Code)
	}
	if result.Error.LastPollStatus != "failed" {
		t.Errorf("expected last_poll_status=failed, got %s", result.Error.LastPollStatus)
	}
}

func TestVerify_Timeout(t *testing.T) {
	var callCount atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount.Add(1)
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"id":         "exec-1",
			"routine_id": "routine-1",
			"status":     "pending",
		})
	}))
	defer srv.Close()

	c := client.NewRoutinesClient(srv.URL, "token", 5*time.Second)
	step := NewVerifyExecutionStep(c, 200*time.Millisecond, 50*time.Millisecond)

	state := &RunState{
		RunID:       "test-run",
		RoutineID:   "routine-1",
		ExecutionID: "exec-1",
		StepResults: make(map[string]string),
	}

	result := step.Run(context.Background(), state)

	if result.Result != "fail" {
		t.Errorf("expected fail, got %s", result.Result)
	}
	if result.Error == nil {
		t.Fatal("expected error")
	}
	if result.Error.Code != "EXECUTION_TIMEOUT" {
		t.Errorf("expected EXECUTION_TIMEOUT, got %s", result.Error.Code)
	}
	if result.Error.LastPollStatus != "pending" {
		t.Errorf("expected last_poll_status=pending, got %s", result.Error.LastPollStatus)
	}
}

func TestVerify_PollInterval(t *testing.T) {
	var timestamps []time.Time
	var callCount atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		timestamps = append(timestamps, time.Now())
		n := callCount.Add(1)
		w.Header().Set("Content-Type", "application/json")
		status := "pending"
		if n >= 4 {
			status = "completed"
		}
		json.NewEncoder(w).Encode(map[string]string{
			"id":         "exec-1",
			"routine_id": "routine-1",
			"status":     status,
		})
	}))
	defer srv.Close()

	pollInterval := 100 * time.Millisecond
	c := client.NewRoutinesClient(srv.URL, "token", 5*time.Second)
	step := NewVerifyExecutionStep(c, 5*time.Second, pollInterval)

	state := &RunState{
		RunID:       "test-run",
		RoutineID:   "routine-1",
		ExecutionID: "exec-1",
		StepResults: make(map[string]string),
	}

	step.Run(context.Background(), state)

	if len(timestamps) < 3 {
		t.Fatalf("expected at least 3 polls, got %d", len(timestamps))
	}

	tolerance := 50 * time.Millisecond
	for i := 1; i < len(timestamps); i++ {
		gap := timestamps[i].Sub(timestamps[i-1])
		if gap < pollInterval-tolerance || gap > pollInterval+tolerance {
			t.Errorf("poll gap %d: %v, expected ~%v (tolerance %v)", i, gap, pollInterval, tolerance)
		}
	}
}

func TestVerify_PollErrorsSwallowedBelowThreshold(t *testing.T) {
	// Server returns errors for the first 4 requests (2 poll attempts with retry),
	// then succeeds. The verify step should recover and pass.
	var callCount atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := callCount.Add(1)
		w.Header().Set("Content-Type", "application/json")
		// doWithRetry retries once on 500, so 4 server calls = 2 poll errors
		if n <= 4 {
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`{"error":"temporary"}`))
			return
		}
		json.NewEncoder(w).Encode(map[string]string{
			"id":         "exec-1",
			"routine_id": "routine-1",
			"status":     "completed",
		})
	}))
	defer srv.Close()

	c := client.NewRoutinesClient(srv.URL, "token", 5*time.Second)
	step := NewVerifyExecutionStep(c, 30*time.Second, 50*time.Millisecond)

	state := &RunState{
		RunID:       "test-run",
		RoutineID:   "routine-1",
		ExecutionID: "exec-1",
		StepResults: make(map[string]string),
	}

	result := step.Run(context.Background(), state)

	if result.Result != "pass" {
		t.Errorf("expected pass, got %s", result.Result)
	}
	if result.Error != nil {
		t.Errorf("expected no error, got %+v", result.Error)
	}
}

func TestVerify_PollUnreachableAfterThreshold(t *testing.T) {
	// Server always returns errors. After maxConsecutivePollErrors the step
	// should short-circuit with POLL_UNREACHABLE instead of waiting for timeout.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"server down"}`))
	}))
	defer srv.Close()

	c := client.NewRoutinesClient(srv.URL, "token", 5*time.Second)
	step := NewVerifyExecutionStep(c, 60*time.Second, 50*time.Millisecond)

	state := &RunState{
		RunID:       "test-run",
		RoutineID:   "routine-1",
		ExecutionID: "exec-1",
		StepResults: make(map[string]string),
	}

	result := step.Run(context.Background(), state)

	if result.Result != "fail" {
		t.Errorf("expected fail, got %s", result.Result)
	}
	if result.Error == nil {
		t.Fatal("expected error")
	}
	if result.Error.Code != "POLL_UNREACHABLE" {
		t.Errorf("expected POLL_UNREACHABLE, got %s", result.Error.Code)
	}
	if !strings.Contains(result.Error.Message, "consecutive errors") {
		t.Errorf("expected message to mention consecutive errors, got: %s", result.Error.Message)
	}
}

func TestVerify_PollErrorsResetOnSuccess(t *testing.T) {
	// Server alternates: errors then success, repeating. The consecutive error
	// count resets on each success so it never hits the threshold.
	// doWithRetry retries once on 500, so each poll error = 2 server hits.
	// Pattern per poll: calls 1-2 error, call 3 success (pending),
	// calls 4-5 error, call 6 success (pending), call 7 success (completed).
	var callCount atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := callCount.Add(1)
		w.Header().Set("Content-Type", "application/json")
		switch {
		case n <= 2:
			// First poll: initial + retry both fail
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`{"error":"blip"}`))
		case n == 3:
			// Second poll: success (resets counter)
			json.NewEncoder(w).Encode(map[string]string{
				"id":         "exec-1",
				"routine_id": "routine-1",
				"status":     "pending",
			})
		case n <= 5:
			// Third poll: initial + retry both fail
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`{"error":"blip"}`))
		case n == 6:
			// Fourth poll: success (resets counter)
			json.NewEncoder(w).Encode(map[string]string{
				"id":         "exec-1",
				"routine_id": "routine-1",
				"status":     "pending",
			})
		default:
			// Fifth poll onwards: completed
			json.NewEncoder(w).Encode(map[string]string{
				"id":         "exec-1",
				"routine_id": "routine-1",
				"status":     "completed",
			})
		}
	}))
	defer srv.Close()

	c := client.NewRoutinesClient(srv.URL, "token", 5*time.Second)
	step := NewVerifyExecutionStep(c, 30*time.Second, 50*time.Millisecond)

	state := &RunState{
		RunID:       "test-run",
		RoutineID:   "routine-1",
		ExecutionID: "exec-1",
		StepResults: make(map[string]string),
	}

	result := step.Run(context.Background(), state)

	if result.Result != "pass" {
		t.Errorf("expected pass, got %s", result.Result)
	}
	if result.Error != nil {
		t.Errorf("expected no error, got %+v", result.Error)
	}
}
