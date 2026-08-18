package runner

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/client"
	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/config"
	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/logging"
	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/steps"
)

type RunResult struct {
	Passed      bool
	RunID       string
	Duration    time.Duration
	StepResults map[string]string
}

type SuiteRunner struct {
	config         *config.Config
	client         *client.RoutinesClient
	logger         func() interface{}
	failureTracker *FailureTracker
}

func NewSuiteRunner(cfg *config.Config, c *client.RoutinesClient, ft *FailureTracker) *SuiteRunner {
	return &SuiteRunner{
		config:         cfg,
		client:         c,
		failureTracker: ft,
	}
}

func (r *SuiteRunner) Run(ctx context.Context) RunResult {
	runID := r.generateRunID()
	state := &steps.RunState{
		RunID:       runID,
		StepResults: make(map[string]string),
	}

	mode := "continuous"
	if r.config.Once {
		mode = "once"
	}
	logging.LogRunStart(runID, mode, r.config.TargetURL)
	start := time.Now()

	allSteps := []steps.Step{
		steps.NewHealthCheckStep(r.client, r.config.HealthTimeout),
		steps.NewCreateRoutineStep(r.client, r.config.CreateTimeout),
		steps.NewTriggerExecutionStep(r.client, r.config.CreateTimeout),
		steps.NewVerifyExecutionStep(r.client, r.config.ExecTimeout, r.config.PollInterval),
		steps.NewCleanupStep(r.client, r.config.CreateTimeout),
	}

	passed := true
	cleanupNeeded := false
	cleanupDone := false

	for _, step := range allSteps {
		if step.Name() == "cleanup" {
			if !state.ResourceCreated {
				state.StepResults["cleanup"] = "skip"
				continue
			}
			result := r.executeStep(step, ctx, state)
			state.StepResults[result.Name] = result.Result
			cleanupDone = true
			if result.Result == "fail" {
				logging.Logger().Warn("cleanup_warning",
					"run_id", runID,
					"error", result.Error.Message,
				)
			}
			continue
		}

		if !passed && step.Name() != "cleanup" {
			if state.ResourceCreated && !cleanupNeeded {
				cleanupNeeded = true
			}
			state.StepResults[step.Name()] = "skip"
			continue
		}

		result := r.executeStep(step, ctx, state)
		state.StepResults[result.Name] = result.Result

		if result.Result == "fail" {
			passed = false

			if step.Name() == "health_check" {
				break
			}
		}
	}

	if cleanupNeeded && state.ResourceCreated && !cleanupDone {
		cleanup := steps.NewCleanupStep(r.client, r.config.CreateTimeout)
		result := r.executeStep(cleanup, ctx, state)
		state.StepResults[result.Name] = result.Result
		if result.Result == "fail" {
			logging.Logger().Warn("cleanup_warning",
				"run_id", runID,
				"error", result.Error.Message,
			)
		}
	}

	duration := time.Since(start)
	r.failureTracker.Record(passed)

	resultStr := "pass"
	if !passed {
		resultStr = "fail"
	}

	logging.LogRunComplete(runID, resultStr, duration.Milliseconds(), state.StepResults, r.failureTracker.ConsecutiveFailures())

	return RunResult{
		Passed:      passed,
		RunID:       runID,
		Duration:    duration,
		StepResults: state.StepResults,
	}
}

func (r *SuiteRunner) executeStep(step steps.Step, ctx context.Context, state *steps.RunState) steps.StepResult {
	result := step.Run(ctx, state)

	var errForLog error
	details := ""
	if result.Error != nil {
		errForLog = fmt.Errorf("[%s] %s", result.Error.Code, result.Error.Message)
	}
	if result.Details != nil {
		if id, ok := result.Details["routine_id"]; ok {
			details = fmt.Sprintf("%v", id)
		} else if id, ok := result.Details["execution_id"]; ok {
			details = fmt.Sprintf("%v", id)
		}
	}

	logging.LogStepResult(state.RunID, result.Name, result.Result, result.Duration.Milliseconds(), details, errForLog)

	return result
}

func (r *SuiteRunner) generateRunID() string {
	now := time.Now().UTC()
	b := make([]byte, 3)
	rand.Read(b)
	return fmt.Sprintf("%s-%s-%s-%s",
		r.config.IdemPrefix,
		now.Format("20060102"),
		now.Format("150405"),
		hex.EncodeToString(b),
	)
}
