package steps

import (
	"context"
	"strings"
	"time"

	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/client"
)

type CleanupStep struct {
	client  *client.RoutinesClient
	timeout time.Duration
}

func NewCleanupStep(c *client.RoutinesClient, timeout time.Duration) *CleanupStep {
	return &CleanupStep{client: c, timeout: timeout}
}

func (s *CleanupStep) Name() string {
	return "cleanup"
}

func (s *CleanupStep) Run(ctx context.Context, state *RunState) StepResult {
	start := time.Now()
	dctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	err := s.client.DeleteRoutine(dctx, state.RoutineID)
	duration := time.Since(start)

	if err == nil {
		return StepResult{
			Name:     s.Name(),
			Result:   "pass",
			Duration: duration,
		}
	}

	if strings.Contains(err.Error(), "404") || strings.Contains(err.Error(), "not found") {
		return StepResult{
			Name:     s.Name(),
			Result:   "pass",
			Duration: duration,
		}
	}

	return StepResult{
		Name:     s.Name(),
		Result:   "fail",
		Duration: duration,
		Error: &StepError{
			Code:    "CLEANUP_FAILED",
			Message: err.Error(),
		},
	}
}
