package logging

import (
	"log/slog"
	"os"
	"time"
)

var logger *slog.Logger

func Init(level string) {
	var lvl slog.Level
	switch level {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}

	logger = slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: lvl,
	}))
}

func Logger() *slog.Logger {
	if logger == nil {
		Init("info")
	}
	return logger
}

func LogRunStart(runID, mode, targetURL string) {
	Logger().Info("run_start",
		"run_id", runID,
		"mode", mode,
		"target_url", targetURL,
		"timestamp", time.Now().UTC().Format(time.RFC3339),
	)
}

func LogStepResult(runID, step, result string, durationMs int64, details string, err error) {
	attrs := []any{
		"run_id", runID,
		"step", step,
		"result", result,
		"duration_ms", durationMs,
		"timestamp", time.Now().UTC().Format(time.RFC3339),
	}
	if details != "" {
		attrs = append(attrs, "details", details)
	}
	if err != nil {
		attrs = append(attrs, "error", err.Error())
	}

	if result == "pass" {
		Logger().Info("step_result", attrs...)
	} else {
		Logger().Error("step_result", attrs...)
	}
}

func LogRunComplete(runID, result string, totalDurationMs int64, steps map[string]string, consecutiveFailures int) {
	Logger().Info("run_complete",
		"run_id", runID,
		"result", result,
		"total_duration_ms", totalDurationMs,
		"steps", steps,
		"consecutive_failures", consecutiveFailures,
		"timestamp", time.Now().UTC().Format(time.RFC3339),
	)
}
