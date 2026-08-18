package steps

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/client"
)

const maxConsecutivePollErrors = 5

type VerifyExecutionStep struct {
	client       *client.RoutinesClient
	execTimeout  time.Duration
	pollInterval time.Duration
}

func NewVerifyExecutionStep(c *client.RoutinesClient, execTimeout, pollInterval time.Duration) *VerifyExecutionStep {
	return &VerifyExecutionStep{
		client:       c,
		execTimeout:  execTimeout,
		pollInterval: pollInterval,
	}
}

func (s *VerifyExecutionStep) Name() string {
	return "verify_execution"
}

func (s *VerifyExecutionStep) Run(ctx context.Context, state *RunState) StepResult {
	start := time.Now()
	deadline := time.After(s.execTimeout)
	ticker := time.NewTicker(s.pollInterval)
	defer ticker.Stop()

	var lastStatus string
	var pollErrors int

	for {
		select {
		case <-ctx.Done():
			return s.timeoutResult(start, lastStatus, pollErrors)
		case <-deadline:
			return s.timeoutResult(start, lastStatus, pollErrors)
		case <-ticker.C:
			exec, err := s.client.GetExecution(ctx, state.RoutineID, state.ExecutionID)
			if err != nil {
				pollErrors++
				slog.Debug("poll error",
					"step", s.Name(),
					"error", err,
					"consecutive_errors", pollErrors,
					"routine_id", state.RoutineID,
					"execution_id", state.ExecutionID,
				)
				if pollErrors >= maxConsecutivePollErrors {
					return StepResult{
						Name:     s.Name(),
						Result:   "fail",
						Duration: time.Since(start),
						Error: &StepError{
							Code:           "POLL_UNREACHABLE",
							Message:        fmt.Sprintf("polling failed: %d consecutive errors, last: %s", pollErrors, err.Error()),
							LastPollStatus: lastStatus,
							ElapsedMs:      time.Since(start).Milliseconds(),
						},
					}
				}
				continue
			}

			pollErrors = 0
			lastStatus = exec.Status

			switch exec.Status {
			case "completed", "succeeded":
				return StepResult{
					Name:     s.Name(),
					Result:   "pass",
					Duration: time.Since(start),
					Details: map[string]interface{}{
						"final_status":     exec.Status,
						"last_poll_status": lastStatus,
						"elapsed_ms":       time.Since(start).Milliseconds(),
						"poll_errors":      pollErrors,
					},
				}
			case "failed":
				return StepResult{
					Name:     s.Name(),
					Result:   "fail",
					Duration: time.Since(start),
					Error: &StepError{
						Code:           "EXECUTION_FAILED",
						Message:        fmt.Sprintf("execution finished with status: %s", exec.Status),
						LastPollStatus: lastStatus,
						ElapsedMs:      time.Since(start).Milliseconds(),
					},
				}
			}
		}
	}
}

func (s *VerifyExecutionStep) timeoutResult(start time.Time, lastStatus string, pollErrors int) StepResult {
	return StepResult{
		Name:     s.Name(),
		Result:   "fail",
		Duration: time.Since(start),
		Details: map[string]interface{}{
			"poll_errors": pollErrors,
		},
		Error: &StepError{
			Code:           "EXECUTION_TIMEOUT",
			Message:        "execution did not complete within timeout",
			LastPollStatus: lastStatus,
			ElapsedMs:      time.Since(start).Milliseconds(),
		},
	}
}
