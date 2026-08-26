package steps

import (
	"context"
	"time"
)

type RunState struct {
	RunID           string
	RoutineID       string
	ExecutionID     string
	ResourceCreated bool
	StepResults     map[string]string
}

type Step interface {
	Name() string
	Run(ctx context.Context, state *RunState) StepResult
}

type StepResult struct {
	Name     string
	Result   string
	Duration time.Duration
	Details  map[string]interface{}
	Error    *StepError
}

type StepError struct {
	Code           string
	Message        string
	HTTPStatus     *int
	LastPollStatus string
	ElapsedMs      int64
}
