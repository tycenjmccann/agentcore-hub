package config

import (
	"os"
	"testing"
	"time"
)

func TestConfig_Defaults(t *testing.T) {
	cfg := &Config{}

	cfg.TargetURL = "https://example.com"
	cfg.AuthToken = "test-token"
	cfg.Interval = 5 * time.Minute
	cfg.ExecTimeout = 30 * time.Second
	cfg.CreateTimeout = 5 * time.Second
	cfg.HealthTimeout = 2 * time.Second
	cfg.PollInterval = 2 * time.Second
	cfg.FailureThreshold = 3
	cfg.Once = false
	cfg.ListenAddr = ":8080"
	cfg.LogLevel = "info"
	cfg.IdemPrefix = "e2e-probe"
	cfg.CleanupStale = true
	cfg.AllowInsecure = false

	if cfg.Interval != 5*time.Minute {
		t.Errorf("expected default interval 5m, got %v", cfg.Interval)
	}
	if cfg.ExecTimeout != 30*time.Second {
		t.Errorf("expected default exec-timeout 30s, got %v", cfg.ExecTimeout)
	}
	if cfg.CreateTimeout != 5*time.Second {
		t.Errorf("expected default create-timeout 5s, got %v", cfg.CreateTimeout)
	}
	if cfg.HealthTimeout != 2*time.Second {
		t.Errorf("expected default health-timeout 2s, got %v", cfg.HealthTimeout)
	}
	if cfg.PollInterval != 2*time.Second {
		t.Errorf("expected default poll-interval 2s, got %v", cfg.PollInterval)
	}
	if cfg.FailureThreshold != 3 {
		t.Errorf("expected default failure-threshold 3, got %d", cfg.FailureThreshold)
	}
	if cfg.Once {
		t.Error("expected default once=false")
	}
	if cfg.ListenAddr != ":8080" {
		t.Errorf("expected default listen-addr :8080, got %s", cfg.ListenAddr)
	}
	if cfg.LogLevel != "info" {
		t.Errorf("expected default log-level info, got %s", cfg.LogLevel)
	}
	if cfg.IdemPrefix != "e2e-probe" {
		t.Errorf("expected default idem-prefix e2e-probe, got %s", cfg.IdemPrefix)
	}
	if !cfg.CleanupStale {
		t.Error("expected default cleanup-stale=true")
	}
	if cfg.AllowInsecure {
		t.Error("expected default allow-insecure=false")
	}
}

func TestConfig_RequiredFieldsMissing(t *testing.T) {
	tests := []struct {
		name      string
		cfg       Config
		wantError string
	}{
		{
			name:      "missing target-url",
			cfg:       Config{AuthToken: "token", AllowInsecure: true},
			wantError: "target-url is required",
		},
		{
			name:      "missing auth-token",
			cfg:       Config{TargetURL: "https://example.com"},
			wantError: "auth-token is required",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.cfg.Validate()
			if err == nil {
				t.Fatal("expected error, got nil")
			}
			if err.Error() != tt.wantError {
				t.Errorf("expected error %q, got %q", tt.wantError, err.Error())
			}
		})
	}
}

func TestConfig_EnvVarOverride(t *testing.T) {
	cfg := &Config{}

	os.Setenv("PROBE_TARGET_URL", "https://env-target.example.com")
	os.Setenv("PROBE_AUTH_TOKEN", "env-token-123")
	defer os.Unsetenv("PROBE_TARGET_URL")
	defer os.Unsetenv("PROBE_AUTH_TOKEN")

	applyEnvOverrides(cfg)

	if cfg.TargetURL != "https://env-target.example.com" {
		t.Errorf("expected env target URL, got %s", cfg.TargetURL)
	}
	if cfg.AuthToken != "env-token-123" {
		t.Errorf("expected env auth token, got %s", cfg.AuthToken)
	}
}

func TestConfig_HTTPSRequired(t *testing.T) {
	cfg := Config{
		TargetURL:     "http://example.com",
		AuthToken:     "token",
		AllowInsecure: false,
	}

	err := cfg.Validate()
	if err == nil {
		t.Fatal("expected error for http:// URL without allow-insecure")
	}
	if err.Error() != "target-url must start with https:// (use --allow-insecure to override)" {
		t.Errorf("unexpected error: %v", err)
	}

	cfg.AllowInsecure = true
	err = cfg.Validate()
	if err != nil {
		t.Errorf("expected no error with allow-insecure, got: %v", err)
	}
}

func TestConfig_ValidDurations(t *testing.T) {
	cfg := &Config{}

	os.Setenv("PROBE_INTERVAL", "10m")
	os.Setenv("PROBE_EXEC_TIMEOUT", "45s")
	os.Setenv("PROBE_CREATE_TIMEOUT", "3s")
	os.Setenv("PROBE_HEALTH_TIMEOUT", "1s")
	os.Setenv("PROBE_POLL_INTERVAL", "500ms")
	defer func() {
		os.Unsetenv("PROBE_INTERVAL")
		os.Unsetenv("PROBE_EXEC_TIMEOUT")
		os.Unsetenv("PROBE_CREATE_TIMEOUT")
		os.Unsetenv("PROBE_HEALTH_TIMEOUT")
		os.Unsetenv("PROBE_POLL_INTERVAL")
	}()

	applyEnvOverrides(cfg)

	if cfg.Interval != 10*time.Minute {
		t.Errorf("expected interval 10m, got %v", cfg.Interval)
	}
	if cfg.ExecTimeout != 45*time.Second {
		t.Errorf("expected exec-timeout 45s, got %v", cfg.ExecTimeout)
	}
	if cfg.CreateTimeout != 3*time.Second {
		t.Errorf("expected create-timeout 3s, got %v", cfg.CreateTimeout)
	}
	if cfg.HealthTimeout != 1*time.Second {
		t.Errorf("expected health-timeout 1s, got %v", cfg.HealthTimeout)
	}
	if cfg.PollInterval != 500*time.Millisecond {
		t.Errorf("expected poll-interval 500ms, got %v", cfg.PollInterval)
	}
}
