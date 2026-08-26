package steps

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/client"
)

type CreateRoutineStep struct {
	client  *client.RoutinesClient
	timeout time.Duration
}

func NewCreateRoutineStep(c *client.RoutinesClient, timeout time.Duration) *CreateRoutineStep {
	return &CreateRoutineStep{client: c, timeout: timeout}
}

func (s *CreateRoutineStep) Name() string {
	return "create_routine"
}

func (s *CreateRoutineStep) Run(ctx context.Context, state *RunState) StepResult {
	start := time.Now()
	cctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	req := client.CreateRoutineRequest{
		Name:           "E2E Probe Synthetic Routine",
		IdempotencyKey: state.RunID,
		Schedule:       "on_demand",
	}

	routine, err := s.client.CreateRoutine(cctx, req)
	if err != nil {
		duration := time.Since(start)
		code := "CREATE_FAILED"
		if cctx.Err() != nil || strings.Contains(err.Error(), "context deadline exceeded") {
			code = "CREATE_TIMEOUT"
		}
		return StepResult{
			Name:     s.Name(),
			Result:   "fail",
			Duration: duration,
			Error: &StepError{
				Code:    code,
				Message: err.Error(),
			},
		}
	}

	state.RoutineID = routine.ID
	state.ResourceCreated = true

	gctx, gcancel := context.WithTimeout(ctx, s.timeout)
	defer gcancel()

	fetched, err := s.client.GetRoutine(gctx, routine.ID)
	if err != nil {
		return StepResult{
			Name:     s.Name(),
			Result:   "fail",
			Duration: time.Since(start),
			Error: &StepError{
				Code:    "CONFIG_MISMATCH",
				Message: fmt.Sprintf("failed to verify routine: %v", err),
			},
		}
	}

	if fetched.Name != req.Name {
		return StepResult{
			Name:     s.Name(),
			Result:   "fail",
			Duration: time.Since(start),
			Error: &StepError{
				Code:    "CONFIG_MISMATCH",
				Message: fmt.Sprintf("name mismatch: expected %q, got %q", req.Name, fetched.Name),
			},
		}
	}

	return StepResult{
		Name:     s.Name(),
		Result:   "pass",
		Duration: time.Since(start),
		Details: map[string]interface{}{
			"routine_id": routine.ID,
		},
	}
}
