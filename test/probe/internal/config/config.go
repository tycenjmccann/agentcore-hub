package config

import (
	"flag"
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	TargetURL        string
	AuthToken        string
	Interval         time.Duration
	ExecTimeout      time.Duration
	CreateTimeout    time.Duration
	HealthTimeout    time.Duration
	PollInterval     time.Duration
	FailureThreshold int
	Once             bool
	ListenAddr       string
	LogLevel         string
	IdemPrefix       string
	CleanupStale     bool
	AllowInsecure    bool
}

func Load() (*Config, error) {
	cfg := &Config{}

	flag.StringVar(&cfg.TargetURL, "target-url", "", "Target service base URL")
	flag.StringVar(&cfg.AuthToken, "auth-token", "", "Bearer token for authentication")
	flag.DurationVar(&cfg.Interval, "interval", 5*time.Minute, "Probe run interval")
	flag.DurationVar(&cfg.ExecTimeout, "exec-timeout", 30*time.Second, "Execution polling timeout")
	flag.DurationVar(&cfg.CreateTimeout, "create-timeout", 5*time.Second, "HTTP timeout for create calls")
	flag.DurationVar(&cfg.HealthTimeout, "health-timeout", 2*time.Second, "HTTP timeout for health checks")
	flag.DurationVar(&cfg.PollInterval, "poll-interval", 2*time.Second, "Polling interval for execution status")
	flag.IntVar(&cfg.FailureThreshold, "failure-threshold", 3, "Consecutive failures before alerting")
	flag.BoolVar(&cfg.Once, "once", false, "Run once and exit")
	flag.StringVar(&cfg.ListenAddr, "listen-addr", ":8080", "Health endpoint listen address")
	flag.StringVar(&cfg.LogLevel, "log-level", "info", "Log level (debug, info, warn, error)")
	flag.StringVar(&cfg.IdemPrefix, "idem-prefix", "e2e-probe", "Idempotency key prefix")
	flag.BoolVar(&cfg.CleanupStale, "cleanup-stale", true, "Clean up stale probe routines")
	flag.BoolVar(&cfg.AllowInsecure, "allow-insecure", false, "Allow non-HTTPS target URLs")

	flag.Parse()

	applyEnvOverrides(cfg)

	if err := cfg.Validate(); err != nil {
		return nil, err
	}

	return cfg, nil
}

func applyEnvOverrides(cfg *Config) {
	if v := os.Getenv("PROBE_TARGET_URL"); v != "" && cfg.TargetURL == "" {
		cfg.TargetURL = v
	}
	if v := os.Getenv("PROBE_AUTH_TOKEN"); v != "" && cfg.AuthToken == "" {
		cfg.AuthToken = v
	}
	if v := os.Getenv("PROBE_INTERVAL"); v != "" && !isFlagSet("interval") {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.Interval = d
		}
	}
	if v := os.Getenv("PROBE_EXEC_TIMEOUT"); v != "" && !isFlagSet("exec-timeout") {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.ExecTimeout = d
		}
	}
	if v := os.Getenv("PROBE_CREATE_TIMEOUT"); v != "" && !isFlagSet("create-timeout") {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.CreateTimeout = d
		}
	}
	if v := os.Getenv("PROBE_HEALTH_TIMEOUT"); v != "" && !isFlagSet("health-timeout") {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.HealthTimeout = d
		}
	}
	if v := os.Getenv("PROBE_POLL_INTERVAL"); v != "" && !isFlagSet("poll-interval") {
		if d, err := time.ParseDuration(v); err == nil {
			cfg.PollInterval = d
		}
	}
	if v := os.Getenv("PROBE_FAILURE_THRESHOLD"); v != "" && !isFlagSet("failure-threshold") {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.FailureThreshold = n
		}
	}
	if v := os.Getenv("PROBE_ONCE"); v != "" && !isFlagSet("once") {
		cfg.Once = v == "true" || v == "1"
	}
	if v := os.Getenv("PROBE_LISTEN_ADDR"); v != "" && !isFlagSet("listen-addr") {
		cfg.ListenAddr = v
	}
	if v := os.Getenv("PROBE_LOG_LEVEL"); v != "" && !isFlagSet("log-level") {
		cfg.LogLevel = v
	}
	if v := os.Getenv("PROBE_IDEM_PREFIX"); v != "" && !isFlagSet("idem-prefix") {
		cfg.IdemPrefix = v
	}
	if v := os.Getenv("PROBE_CLEANUP_STALE"); v != "" && !isFlagSet("cleanup-stale") {
		cfg.CleanupStale = v == "true" || v == "1"
	}
}

func isFlagSet(name string) bool {
	found := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == name {
			found = true
		}
	})
	return found
}

func (c *Config) Validate() error {
	if c.TargetURL == "" {
		return fmt.Errorf("target-url is required")
	}
	if !c.AllowInsecure {
		if len(c.TargetURL) < 8 || c.TargetURL[:8] != "https://" {
			return fmt.Errorf("target-url must start with https:// (use --allow-insecure to override)")
		}
	}
	if c.AuthToken == "" {
		return fmt.Errorf("auth-token is required")
	}
	return nil
}
