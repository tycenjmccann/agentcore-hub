package main

import (
	"context"
	"encoding/json"
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
	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/runner"
)

const (
	exitPass        = 0
	exitFail        = 1
	exitConfigError = 2
	shutdownGrace   = 60 * time.Second
)

var healthy atomic.Bool

func main() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "configuration error: %v\n", err)
		os.Exit(exitConfigError)
	}

	logging.Init(cfg.LogLevel)

	rc := client.NewRoutinesClient(cfg.TargetURL, cfg.AuthToken, cfg.CreateTimeout)
	tracker := runner.NewFailureTracker(cfg.FailureThreshold)
	suite := runner.NewSuiteRunner(cfg, rc, tracker)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigCh
		cancel()
	}()

	go startHealthServer(cfg.ListenAddr)

	if cfg.Once {
		result := suite.Run(ctx)
		healthy.Store(result.Passed)
		if result.Passed {
			os.Exit(exitPass)
		}
		os.Exit(exitFail)
	}

	healthy.Store(true)
	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()

	runAndUpdate(ctx, suite)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			runAndUpdate(ctx, suite)
		}
	}
}

func runAndUpdate(ctx context.Context, suite *runner.SuiteRunner) {
	result := suite.Run(ctx)
	healthy.Store(result.Passed)
}

func startHealthServer(addr string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if healthy.Load() {
			w.WriteHeader(http.StatusOK)
			json.NewEncoder(w).Encode(map[string]string{"status": "healthy"})
		} else {
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(map[string]string{"status": "unhealthy", "error": "cannot reach Routines API"})
		}
	})

	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	server.ListenAndServe()
}
