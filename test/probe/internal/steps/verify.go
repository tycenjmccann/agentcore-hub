package steps

import (
	"context"
	"fmt"
	"time"

	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/client"
)

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

	for {
		select {
		case <-ctx.Done():
			return s.timeoutResult(start, lastStatus)
		case <-deadline:
			return s.timeoutResult(start, lastStatus)
		case <-ticker.C:
			exec, err := s.client.GetExecution(ctx, state.RoutineID, state.ExecutionID)
			if err != nil {
				continue
			}

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

func (s *VerifyExecutionStep) timeoutResult(start time.Time, lastStatus string) StepResult {
	return StepResult{
		Name:     s.Name(),
		Result:   "fail",
		Duration: time.Since(start),
		Error: &StepError{
			Code:           "EXECUTION_TIMEOUT",
			Message:        "execution did not complete within timeout",
			LastPollStatus: lastStatus,
			ElapsedMs:      time.Since(start).Milliseconds(),
		},
	}
}
