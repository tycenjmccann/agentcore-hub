package runner

import (
	"bytes"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/tycenjmccann/agentcore-hub/test/probe/internal/logging"
)

func TestTracker_IncrementOnFailure(t *testing.T) {
	ft := NewFailureTracker(5)

	ft.Record(false)
	if got := ft.ConsecutiveFailures(); got != 1 {
		t.Errorf("expected 1, got %d", got)
	}

	ft.Record(false)
	if got := ft.ConsecutiveFailures(); got != 2 {
		t.Errorf("expected 2, got %d", got)
	}

	ft.Record(false)
	if got := ft.ConsecutiveFailures(); got != 3 {
		t.Errorf("expected 3, got %d", got)
	}
}

func TestTracker_ResetOnSuccess(t *testing.T) {
	ft := NewFailureTracker(5)

	ft.Record(false)
	ft.Record(false)
	ft.Record(true)

	if got := ft.ConsecutiveFailures(); got != 0 {
		t.Errorf("expected 0 after success, got %d", got)
	}
}

func TestTracker_ThresholdNotBreached(t *testing.T) {
	ft := NewFailureTracker(3)

	ft.Record(false)
	ft.Record(false)

	if ft.ThresholdBreached() {
		t.Error("threshold should not be breached at count 2 with threshold 3")
	}
}

func TestTracker_ThresholdBreached(t *testing.T) {
	ft := NewFailureTracker(3)

	ft.Record(false)
	ft.Record(false)
	ft.Record(false)

	if !ft.ThresholdBreached() {
		t.Error("threshold should be breached at count 3 with threshold 3")
	}

	ft.Record(false)
	if !ft.ThresholdBreached() {
		t.Error("threshold should remain breached above threshold")
	}
}

func TestTracker_ThresholdAfterReset(t *testing.T) {
	ft := NewFailureTracker(2)

	ft.Record(false)
	ft.Record(false)
	if !ft.ThresholdBreached() {
		t.Error("should be breached after 2 failures with threshold 2")
	}

	ft.Record(true)
	if ft.ThresholdBreached() {
		t.Error("should not be breached after reset")
	}
	if got := ft.ConsecutiveFailures(); got != 0 {
		t.Errorf("expected 0, got %d", got)
	}

	ft.Record(false)
	if ft.ThresholdBreached() {
		t.Error("should not be breached after single failure with threshold 2")
	}
	if got := ft.ConsecutiveFailures(); got != 1 {
		t.Errorf("expected 1, got %d", got)
	}
}

func TestTracker_Concurrent(t *testing.T) {
	ft := NewFailureTracker(100)
	var wg sync.WaitGroup

	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ft.Record(false)
		}()
	}

	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = ft.ConsecutiveFailures()
		}()
	}

	wg.Wait()

	ft.Record(true)
	if got := ft.ConsecutiveFailures(); got != 0 {
		t.Errorf("expected 0 after final reset, got %d", got)
	}
}

func TestTracker_Threshold5_AlertAtExactly5(t *testing.T) {
	var buf bytes.Buffer
	logging.SetLogger(slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})))
	defer logging.Init("info")

	ft := NewFailureTracker(5)

	// Failures 1-4 should not produce an alert log
	for i := 0; i < 4; i++ {
		ft.Record(false)
	}
	if strings.Contains(buf.String(), `"alert"`) {
		t.Error("alert should not fire before reaching threshold 5")
	}

	buf.Reset()
	ft.Record(false) // failure 5 — should trigger alert
	if !strings.Contains(buf.String(), `"alert"`) {
		t.Error("alert should fire at exactly 5 consecutive failures with threshold 5")
	}
}

func TestTracker_Threshold2_AlertAt2_ErrorAt1(t *testing.T) {
	var buf bytes.Buffer
	logging.SetLogger(slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})))
	defer logging.Init("info")

	ft := NewFailureTracker(2)

	// Failure 1: threshold-1 == 1, so this should be an ERROR without alert
	ft.Record(false)
	output := buf.String()
	if !strings.Contains(output, `"level":"ERROR"`) {
		t.Errorf("expected ERROR level at failure 1 with threshold 2, got: %s", output)
	}
	if strings.Contains(output, `"alert"`) {
		t.Error("alert should not fire at failure 1 with threshold 2")
	}

	buf.Reset()
	// Failure 2: meets threshold, should produce alert
	ft.Record(false)
	output = buf.String()
	if !strings.Contains(output, `"alert"`) {
		t.Error("alert should fire at exactly 2 consecutive failures with threshold 2")
	}
}
