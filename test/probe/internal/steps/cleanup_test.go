package steps

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/client"
)

func TestCleanup_Success204(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	c := client.NewRoutinesClient(srv.URL, "token", 5*time.Second)
	step := NewCleanupStep(c, 5*time.Second)

	state := &RunState{
		RunID:       "test-run",
		RoutineID:   "routine-1",
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

func TestCleanup_Success404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	c := client.NewRoutinesClient(srv.URL, "token", 5*time.Second)
	step := NewCleanupStep(c, 5*time.Second)

	state := &RunState{
		RunID:       "test-run",
		RoutineID:   "routine-1",
		StepResults: make(map[string]string),
	}

	result := step.Run(context.Background(), state)

	if result.Result != "pass" {
		t.Errorf("expected pass for 404 (already deleted), got %s", result.Result)
	}
	if result.Error != nil {
		t.Errorf("expected no error, got %+v", result.Error)
	}
}

func TestCleanup_Failure500(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := client.NewRoutinesClient(srv.URL, "token", 5*time.Second)
	step := NewCleanupStep(c, 5*time.Second)

	state := &RunState{
		RunID:       "test-run",
		RoutineID:   "routine-1",
		StepResults: make(map[string]string),
	}

	result := step.Run(context.Background(), state)

	if result.Result != "fail" {
		t.Errorf("expected fail, got %s", result.Result)
	}
	if result.Error == nil {
		t.Fatal("expected error")
	}
	if result.Error.Code != "CLEANUP_FAILED" {
		t.Errorf("expected CLEANUP_FAILED, got %s", result.Error.Code)
	}
}
