package steps

import (
	"context"
	"time"

	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/client"
)

type TriggerExecutionStep struct {
	client  *client.RoutinesClient
	timeout time.Duration
}

func NewTriggerExecutionStep(c *client.RoutinesClient, timeout time.Duration) *TriggerExecutionStep {
	return &TriggerExecutionStep{client: c, timeout: timeout}
}

func (s *TriggerExecutionStep) Name() string {
	return "trigger_execution"
}

func (s *TriggerExecutionStep) Run(ctx context.Context, state *RunState) StepResult {
	start := time.Now()
	tctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	trigger, err := s.client.TriggerExecution(tctx, state.RoutineID)
	if err != nil {
		return StepResult{
			Name:     s.Name(),
			Result:   "fail",
			Duration: time.Since(start),
			Error: &StepError{
				Code:    "TRIGGER_FAILED",
				Message: err.Error(),
			},
		}
	}

	state.ExecutionID = trigger.ExecutionID

	return StepResult{
		Name:     s.Name(),
		Result:   "pass",
		Duration: time.Since(start),
		Details: map[string]interface{}{
			"execution_id": trigger.ExecutionID,
		},
	}
}
