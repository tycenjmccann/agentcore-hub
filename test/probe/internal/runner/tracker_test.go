package runner

import (
	"sync"
	"testing"
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
