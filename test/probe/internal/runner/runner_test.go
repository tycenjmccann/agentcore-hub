package runner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/client"
	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/config"
)

type endpointTracker struct {
	healthCalls  atomic.Int32
	createCalls  atomic.Int32
	getCalls     atomic.Int32
	triggerCalls atomic.Int32
	execCalls    atomic.Int32
	deleteCalls  atomic.Int32
}

func setupTestServer(t *testing.T, tracker *endpointTracker, handlers map[string]http.HandlerFunc) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		tracker.healthCalls.Add(1)
		if h, ok := handlers["health"]; ok {
			h(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
	})

	mux.HandleFunc("/routines", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			tracker.createCalls.Add(1)
			if h, ok := handlers["create"]; ok {
				h(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			json.NewEncoder(w).Encode(map[string]string{
				"id":     "routine-123",
				"name":   "E2E Probe Synthetic Routine",
				"status": "active",
			})
			return
		}
	})

	mux.HandleFunc("/routines/routine-123", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			tracker.getCalls.Add(1)
			if h, ok := handlers["get"]; ok {
				h(w, r)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{
				"id":     "routine-123",
				"name":   "E2E Probe Synthetic Routine",
				"status": "active",
			})
			return
		}
		if r.Method == http.MethodDelete {
			tracker.deleteCalls.Add(1)
			if h, ok := handlers["delete"]; ok {
				h(w, r)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
	})

	mux.HandleFunc("/routines/routine-123/trigger", func(w http.ResponseWriter, r *http.Request) {
		tracker.triggerCalls.Add(1)
		if h, ok := handlers["trigger"]; ok {
			h(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"execution_id": "exec-456",
			"status":       "running",
		})
	})

	mux.HandleFunc("/routines/routine-123/executions/exec-456", func(w http.ResponseWriter, r *http.Request) {
		tracker.execCalls.Add(1)
		if h, ok := handlers["execution"]; ok {
			h(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{
			"id":        "exec-456",
			"routine_id": "routine-123",
			"status":    "completed",
		})
	})

	return httptest.NewServer(mux)
}

func newTestConfig(serverURL string) *config.Config {
	return &config.Config{
		TargetURL:        serverURL,
		AuthToken:        "test-token",
		Interval:         1 * time.Second,
		ExecTimeout:      2 * time.Second,
		CreateTimeout:    2 * time.Second,
		HealthTimeout:    1 * time.Second,
		PollInterval:     50 * time.Millisecond,
		FailureThreshold: 3,
		IdemPrefix:       "test-probe",
		AllowInsecure:    true,
	}
}

func TestRunner_AllStepsPass(t *testing.T) {
	tracker := &endpointTracker{}
	srv := setupTestServer(t, tracker, nil)
	defer srv.Close()

	cfg := newTestConfig(srv.URL)
	c := client.NewRoutinesClient(srv.URL, "test-token", 5*time.Second)
	ft := NewFailureTracker(3)
	runner := NewSuiteRunner(cfg, c, ft)

	result := runner.Run(context.Background())

	if !result.Passed {
		t.Errorf("expected run to pass, got fail. Steps: %v", result.StepResults)
	}
	if tracker.healthCalls.Load() == 0 {
		t.Error("health check was not called")
	}
	if tracker.createCalls.Load() == 0 {
		t.Error("create was not called")
	}
	if tracker.triggerCalls.Load() == 0 {
		t.Error("trigger was not called")
	}
	if tracker.deleteCalls.Load() == 0 {
		t.Error("cleanup (delete) was not called")
	}
}

func TestRunner_HealthCheckFails_AbortsImmediately(t *testing.T) {
	tracker := &endpointTracker{}
	handlers := map[string]http.HandlerFunc{
		"health": func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusForbidden)
		},
	}
	srv := setupTestServer(t, tracker, handlers)
	defer srv.Close()

	cfg := newTestConfig(srv.URL)
	c := client.NewRoutinesClient(srv.URL, "test-token", 5*time.Second)
	ft := NewFailureTracker(3)
	runner := NewSuiteRunner(cfg, c, ft)

	result := runner.Run(context.Background())

	if result.Passed {
		t.Error("expected run to fail when health check fails")
	}
	if result.StepResults["health_check"] != "fail" {
		t.Errorf("expected health_check=fail, got %s", result.StepResults["health_check"])
	}
	if tracker.createCalls.Load() != 0 {
		t.Error("create should not be called when health check fails")
	}
	if tracker.triggerCalls.Load() != 0 {
		t.Error("trigger should not be called when health check fails")
	}
	if tracker.deleteCalls.Load() != 0 {
		t.Error("cleanup should not be called when health check fails")
	}
}

func TestRunner_CreateFails_SkipsToCleanup(t *testing.T) {
	tracker := &endpointTracker{}
	handlers := map[string]http.HandlerFunc{
		"create": func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
		},
	}
	srv := setupTestServer(t, tracker, handlers)
	defer srv.Close()

	cfg := newTestConfig(srv.URL)
	c := client.NewRoutinesClient(srv.URL, "test-token", 5*time.Second)
	ft := NewFailureTracker(3)
	runner := NewSuiteRunner(cfg, c, ft)

	result := runner.Run(context.Background())

	if result.Passed {
		t.Error("expected run to fail when create fails")
	}
	if result.StepResults["create_routine"] != "fail" {
		t.Errorf("expected create_routine=fail, got %s", result.StepResults["create_routine"])
	}
	if tracker.triggerCalls.Load() != 0 {
		t.Error("trigger should be skipped when create fails")
	}
	if result.StepResults["trigger_execution"] != "skip" {
		t.Errorf("expected trigger_execution=skip, got %s", result.StepResults["trigger_execution"])
	}
	if result.StepResults["verify_execution"] != "skip" {
		t.Errorf("expected verify_execution=skip, got %s", result.StepResults["verify_execution"])
	}
}

func TestRunner_TriggerFails_SkipsToCleanup(t *testing.T) {
	tracker := &endpointTracker{}
	handlers := map[string]http.HandlerFunc{
		"trigger": func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
		},
	}
	srv := setupTestServer(t, tracker, handlers)
	defer srv.Close()

	cfg := newTestConfig(srv.URL)
	c := client.NewRoutinesClient(srv.URL, "test-token", 5*time.Second)
	ft := NewFailureTracker(3)
	runner := NewSuiteRunner(cfg, c, ft)

	result := runner.Run(context.Background())

	if result.Passed {
		t.Error("expected run to fail when trigger fails")
	}
	if result.StepResults["trigger_execution"] != "fail" {
		t.Errorf("expected trigger_execution=fail, got %s", result.StepResults["trigger_execution"])
	}
	if result.StepResults["verify_execution"] != "skip" {
		t.Errorf("expected verify_execution=skip, got %s", result.StepResults["verify_execution"])
	}
	if tracker.deleteCalls.Load() == 0 {
		t.Error("cleanup should run after trigger failure (resource was created)")
	}
}

func TestRunner_VerifyFails_CleanupStillRuns(t *testing.T) {
	tracker := &endpointTracker{}
	handlers := map[string]http.HandlerFunc{
		"execution": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{
				"id":         "exec-456",
				"routine_id": "routine-123",
				"status":     "failed",
			})
		},
	}
	srv := setupTestServer(t, tracker, handlers)
	defer srv.Close()

	cfg := newTestConfig(srv.URL)
	c := client.NewRoutinesClient(srv.URL, "test-token", 5*time.Second)
	ft := NewFailureTracker(3)
	runner := NewSuiteRunner(cfg, c, ft)

	result := runner.Run(context.Background())

	if result.Passed {
		t.Error("expected run to fail when verify fails")
	}
	if result.StepResults["verify_execution"] != "fail" {
		t.Errorf("expected verify_execution=fail, got %s", result.StepResults["verify_execution"])
	}
	if tracker.deleteCalls.Load() == 0 {
		t.Error("cleanup should still run after verify failure")
	}
}

func TestRunner_CleanupFails_DoesNotFailRun(t *testing.T) {
	tracker := &endpointTracker{}
	handlers := map[string]http.HandlerFunc{
		"delete": func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusBadRequest)
		},
	}
	srv := setupTestServer(t, tracker, handlers)
	defer srv.Close()

	cfg := newTestConfig(srv.URL)
	c := client.NewRoutinesClient(srv.URL, "test-token", 5*time.Second)
	ft := NewFailureTracker(3)
	runner := NewSuiteRunner(cfg, c, ft)

	result := runner.Run(context.Background())

	if !result.Passed {
		t.Error("run should pass even if cleanup fails (all prior steps passed)")
	}
}

func TestRunner_RunIDFormat(t *testing.T) {
	tracker := &endpointTracker{}
	srv := setupTestServer(t, tracker, nil)
	defer srv.Close()

	cfg := newTestConfig(srv.URL)
	cfg.IdemPrefix = "e2e-probe"
	c := client.NewRoutinesClient(srv.URL, "test-token", 5*time.Second)
	ft := NewFailureTracker(3)
	runner := NewSuiteRunner(cfg, c, ft)

	result := runner.Run(context.Background())

	pattern := `^e2e-probe-\d{8}-\d{6}-[0-9a-f]{6}$`
	matched, err := regexp.MatchString(pattern, result.RunID)
	if err != nil {
		t.Fatalf("regex error: %v", err)
	}
	if !matched {
		t.Errorf("RunID %q does not match expected pattern %s", result.RunID, pattern)
	}
}
