package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/client"
	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/config"
	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/logging"
)

const (
	exitPass        = 0
	exitFail        = 1
	exitConfigError = 2
)

var healthy atomic.Bool

func main() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "configuration error: %v\n", err)
		os.Exit(exitConfigError)
	}

	logging.Init(cfg.LogLevel)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigCh
		cancel()
	}()

	rc := client.NewRoutinesClient(cfg.TargetURL, cfg.AuthToken, cfg.CreateTimeout)

	go startHealthServer(cfg.ListenAddr)

	if cfg.Once {
		result := runProbe(ctx, cfg, rc)
		if result {
			os.Exit(exitPass)
		}
		os.Exit(exitFail)
	}

	healthy.Store(true)
	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()

	runProbe(ctx, cfg, rc)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			runProbe(ctx, cfg, rc)
		}
	}
}

func runProbe(ctx context.Context, cfg *config.Config, rc *client.RoutinesClient) bool {
	runID := fmt.Sprintf("%s-%d", cfg.IdemPrefix, time.Now().UnixNano())
	mode := "continuous"
	if cfg.Once {
		mode = "once"
	}

	logging.LogRunStart(runID, mode, cfg.TargetURL)
	start := time.Now()
	steps := make(map[string]string)
	allPassed := true

	healthCtx, healthCancel := context.WithTimeout(ctx, cfg.HealthTimeout)
	defer healthCancel()
	stepStart := time.Now()
	if err := rc.HealthCheck(healthCtx); err != nil {
		logging.LogStepResult(runID, "health_check", "fail", time.Since(stepStart).Milliseconds(), "", err)
		steps["health_check"] = "fail"
		allPassed = false
		logging.LogRunComplete(runID, "fail", time.Since(start).Milliseconds(), steps, 0)
		healthy.Store(false)
		return false
	}
	logging.LogStepResult(runID, "health_check", "pass", time.Since(stepStart).Milliseconds(), "", nil)
	steps["health_check"] = "pass"

	createCtx, createCancel := context.WithTimeout(ctx, cfg.CreateTimeout)
	defer createCancel()
	stepStart = time.Now()
	routine, err := rc.CreateRoutine(createCtx, client.CreateRoutineRequest{
		Name:           fmt.Sprintf("%s-routine-%d", cfg.IdemPrefix, time.Now().Unix()),
		Description:    "E2E probe test routine",
		Schedule:       "0 */6 * * *",
		IdempotencyKey: fmt.Sprintf("%s-%d", cfg.IdemPrefix, time.Now().UnixNano()),
	})
	if err != nil {
		logging.LogStepResult(runID, "create_routine", "fail", time.Since(stepStart).Milliseconds(), "", err)
		steps["create_routine"] = "fail"
		allPassed = false
		logging.LogRunComplete(runID, "fail", time.Since(start).Milliseconds(), steps, 0)
		healthy.Store(false)
		return false
	}
	logging.LogStepResult(runID, "create_routine", "pass", time.Since(stepStart).Milliseconds(), routine.ID, nil)
	steps["create_routine"] = "pass"

	createCtx2, createCancel2 := context.WithTimeout(ctx, cfg.CreateTimeout)
	defer createCancel2()
	stepStart = time.Now()
	trigger, err := rc.TriggerExecution(createCtx2, routine.ID)
	if err != nil {
		logging.LogStepResult(runID, "trigger_execution", "fail", time.Since(stepStart).Milliseconds(), "", err)
		steps["trigger_execution"] = "fail"
		allPassed = false
	} else {
		logging.LogStepResult(runID, "trigger_execution", "pass", time.Since(stepStart).Milliseconds(), trigger.ExecutionID, nil)
		steps["trigger_execution"] = "pass"

		stepStart = time.Now()
		execDone := pollExecution(ctx, cfg, rc, routine.ID, trigger.ExecutionID)
		if !execDone {
			logging.LogStepResult(runID, "poll_execution", "fail", time.Since(stepStart).Milliseconds(), "", fmt.Errorf("execution did not complete in time"))
			steps["poll_execution"] = "fail"
			allPassed = false
		} else {
			logging.LogStepResult(runID, "poll_execution", "pass", time.Since(stepStart).Milliseconds(), "", nil)
			steps["poll_execution"] = "pass"
		}
	}

	if cfg.CleanupStale {
		deleteCtx, deleteCancel := context.WithTimeout(ctx, cfg.CreateTimeout)
		defer deleteCancel()
		stepStart = time.Now()
		if err := rc.DeleteRoutine(deleteCtx, routine.ID); err != nil {
			logging.LogStepResult(runID, "cleanup", "fail", time.Since(stepStart).Milliseconds(), "", err)
			steps["cleanup"] = "fail"
		} else {
			logging.LogStepResult(runID, "cleanup", "pass", time.Since(stepStart).Milliseconds(), "", nil)
			steps["cleanup"] = "pass"
		}
	}

	result := "pass"
	if !allPassed {
		result = "fail"
		healthy.Store(false)
	} else {
		healthy.Store(true)
	}

	logging.LogRunComplete(runID, result, time.Since(start).Milliseconds(), steps, 0)
	return allPassed
}

func pollExecution(ctx context.Context, cfg *config.Config, rc *client.RoutinesClient, routineID, execID string) bool {
	deadline := time.After(cfg.ExecTimeout)
	ticker := time.NewTicker(cfg.PollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return false
		case <-deadline:
			return false
		case <-ticker.C:
			pollCtx, pollCancel := context.WithTimeout(ctx, cfg.HealthTimeout)
			exec, err := rc.GetExecution(pollCtx, routineID, execID)
			pollCancel()
			if err != nil {
				continue
			}
			if exec.Status == "completed" || exec.Status == "succeeded" {
				return true
			}
			if exec.Status == "failed" || exec.Status == "cancelled" {
				return false
			}
		}
	}
}

func startHealthServer(addr string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if healthy.Load() {
			w.WriteHeader(http.StatusOK)
			fmt.Fprint(w, "ok")
		} else {
			w.WriteHeader(http.StatusServiceUnavailable)
			fmt.Fprint(w, "unhealthy")
		}
	})

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	server.ListenAndServe()
}
