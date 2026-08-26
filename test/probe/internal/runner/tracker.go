package runner

import (
	"sync"

	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/logging"
)

type FailureTracker struct {
	consecutiveFailures int
	threshold           int
	mu                  sync.Mutex
}

func NewFailureTracker(threshold int) *FailureTracker {
	return &FailureTracker{threshold: threshold}
}

func (ft *FailureTracker) Record(passed bool) {
	ft.mu.Lock()
	defer ft.mu.Unlock()

	if passed {
		ft.consecutiveFailures = 0
		return
	}

	ft.consecutiveFailures++

	switch {
	case ft.consecutiveFailures >= 3:
		logging.Logger().Error("consecutive_failures",
			"count", ft.consecutiveFailures,
			"threshold", ft.threshold,
			"alert", true,
		)
	case ft.consecutiveFailures == 2:
		logging.Logger().Error("consecutive_failures",
			"count", ft.consecutiveFailures,
			"threshold", ft.threshold,
		)
	default:
		logging.Logger().Warn("consecutive_failures",
			"count", ft.consecutiveFailures,
			"threshold", ft.threshold,
		)
	}
}

func (ft *FailureTracker) ConsecutiveFailures() int {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	return ft.consecutiveFailures
}

func (ft *FailureTracker) ThresholdBreached() bool {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	return ft.consecutiveFailures >= ft.threshold
}
