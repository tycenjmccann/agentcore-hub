package steps

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
