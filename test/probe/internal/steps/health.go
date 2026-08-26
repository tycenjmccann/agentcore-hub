package steps

import (
	"context"
	"strings"
	"time"

	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/client"
)

type HealthCheckStep struct {
	client  *client.RoutinesClient
	timeout time.Duration
}

func NewHealthCheckStep(c *client.RoutinesClient, timeout time.Duration) *HealthCheckStep {
	return &HealthCheckStep{client: c, timeout: timeout}
}

func (s *HealthCheckStep) Name() string {
	return "health_check"
}

func (s *HealthCheckStep) Run(ctx context.Context, state *RunState) StepResult {
	start := time.Now()
	hctx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	err := s.client.HealthCheck(hctx)
	duration := time.Since(start)

	if err == nil {
		return StepResult{
			Name:     s.Name(),
			Result:   "pass",
			Duration: duration,
		}
	}

	code := "HEALTH_DEGRADED"
	if hctx.Err() != nil || strings.Contains(err.Error(), "context deadline exceeded") ||
		strings.Contains(err.Error(), "connection refused") ||
		strings.Contains(err.Error(), "no such host") {
		code = "HEALTH_UNREACHABLE"
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
