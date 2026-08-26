package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestClient_HealthCheck_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewRoutinesClient(srv.URL, "test-token", 5*time.Second)
	err := c.HealthCheck(context.Background())

	if err != nil {
		t.Errorf("expected no error, got %v", err)
	}
}

func TestClient_HealthCheck_Non200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := NewRoutinesClient(srv.URL, "test-token", 5*time.Second)
	err := c.HealthCheck(context.Background())

	if err == nil {
		t.Fatal("expected error for non-200 response")
	}
}

func TestClient_CreateRoutine_Success(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(Routine{
			ID:     "routine-abc",
			Name:   "Test Routine",
			Status: "active",
		})
	}))
	defer srv.Close()

	c := NewRoutinesClient(srv.URL, "test-token", 5*time.Second)
	routine, err := c.CreateRoutine(context.Background(), CreateRoutineRequest{
		Name:     "Test Routine",
		Schedule: "on_demand",
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if routine.ID != "routine-abc" {
		t.Errorf("expected id routine-abc, got %s", routine.ID)
	}
	if routine.Name != "Test Routine" {
		t.Errorf("expected name Test Routine, got %s", routine.Name)
	}
}

func TestClient_Retry_On5xx(t *testing.T) {
	var callCount atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := callCount.Add(1)
		if n == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewRoutinesClient(srv.URL, "test-token", 5*time.Second)
	err := c.HealthCheck(context.Background())

	if err != nil {
		t.Errorf("expected success after retry, got %v", err)
	}
	if callCount.Load() != 2 {
		t.Errorf("expected 2 calls (initial + retry), got %d", callCount.Load())
	}
}

func TestClient_NoRetry_On4xx(t *testing.T) {
	var callCount atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount.Add(1)
		w.WriteHeader(http.StatusBadRequest)
	}))
	defer srv.Close()

	c := NewRoutinesClient(srv.URL, "test-token", 5*time.Second)
	_, err := c.CreateRoutine(context.Background(), CreateRoutineRequest{
		Name: "Test",
	})

	if err == nil {
		t.Fatal("expected error for 400 response")
	}
	if callCount.Load() != 1 {
		t.Errorf("expected exactly 1 request (no retry on 4xx), got %d", callCount.Load())
	}
}

func TestClient_AuthHeaders(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth != "Bearer my-secret-token" {
			t.Errorf("expected Authorization 'Bearer my-secret-token', got %q", auth)
		}

		ua := r.Header.Get("User-Agent")
		if ua != "routines-e2e-probe/1.0" {
			t.Errorf("expected User-Agent 'routines-e2e-probe/1.0', got %q", ua)
		}

		reqID := r.Header.Get("X-Request-Id")
		if reqID == "" {
			t.Error("expected X-Request-Id header to be set")
		}

		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := NewRoutinesClient(srv.URL, "my-secret-token", 5*time.Second)
	err := c.HealthCheck(context.Background())

	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}
