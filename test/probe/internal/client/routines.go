package client

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"
)

type RoutinesClient struct {
	baseURL    string
	authToken  string
	httpClient *http.Client
}

type CreateRoutineRequest struct {
	Name           string `json:"name"`
	Description    string `json:"description,omitempty"`
	Schedule       string `json:"schedule"`
	IdempotencyKey string `json:"idempotency_key,omitempty"`
}

type Routine struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Schedule    string `json:"schedule,omitempty"`
	Status      string `json:"status"`
	CreatedAt   string `json:"created_at,omitempty"`
}

type TriggerResponse struct {
	ExecutionID string `json:"execution_id"`
	Status      string `json:"status"`
}

type Execution struct {
	ID         string `json:"id"`
	RoutineID  string `json:"routine_id"`
	Status     string `json:"status"`
	StartedAt  string `json:"started_at,omitempty"`
	FinishedAt string `json:"finished_at,omitempty"`
	Result     string `json:"result,omitempty"`
}

func NewRoutinesClient(baseURL, authToken string, timeout time.Duration) *RoutinesClient {
	return &RoutinesClient{
		baseURL:   baseURL,
		authToken: authToken,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}
}

func (c *RoutinesClient) HealthCheck(ctx context.Context) error {
	req, err := c.newRequest(ctx, http.MethodGet, "/health", nil)
	if err != nil {
		return err
	}

	resp, err := c.doWithRetry(req)
	if err != nil {
		return fmt.Errorf("health check failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("health check returned status %d", resp.StatusCode)
	}
	return nil
}

func (c *RoutinesClient) CreateRoutine(ctx context.Context, create CreateRoutineRequest) (*Routine, error) {
	body, err := json.Marshal(create)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	req, err := c.newRequest(ctx, http.MethodPost, "/routines", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.doWithRetry(req)
	if err != nil {
		return nil, fmt.Errorf("create routine: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("create routine returned status %d", resp.StatusCode)
	}

	var routine Routine
	if err := json.NewDecoder(resp.Body).Decode(&routine); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return &routine, nil
}

func (c *RoutinesClient) GetRoutine(ctx context.Context, id string) (*Routine, error) {
	req, err := c.newRequest(ctx, http.MethodGet, "/routines/"+id, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.doWithRetry(req)
	if err != nil {
		return nil, fmt.Errorf("get routine: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("get routine returned status %d", resp.StatusCode)
	}

	var routine Routine
	if err := json.NewDecoder(resp.Body).Decode(&routine); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return &routine, nil
}

func (c *RoutinesClient) TriggerExecution(ctx context.Context, routineID string) (*TriggerResponse, error) {
	req, err := c.newRequest(ctx, http.MethodPost, "/routines/"+routineID+"/trigger", nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.doWithRetry(req)
	if err != nil {
		return nil, fmt.Errorf("trigger execution: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusAccepted {
		return nil, fmt.Errorf("trigger execution returned status %d", resp.StatusCode)
	}

	var trigger TriggerResponse
	if err := json.NewDecoder(resp.Body).Decode(&trigger); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return &trigger, nil
}

func (c *RoutinesClient) GetExecution(ctx context.Context, routineID, execID string) (*Execution, error) {
	path := fmt.Sprintf("/routines/%s/executions/%s", routineID, execID)
	req, err := c.newRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}

	resp, err := c.doWithRetry(req)
	if err != nil {
		return nil, fmt.Errorf("get execution: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("get execution returned status %d", resp.StatusCode)
	}

	var exec Execution
	if err := json.NewDecoder(resp.Body).Decode(&exec); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	return &exec, nil
}

func (c *RoutinesClient) DeleteRoutine(ctx context.Context, id string) error {
	req, err := c.newRequest(ctx, http.MethodDelete, "/routines/"+id, nil)
	if err != nil {
		return err
	}

	resp, err := c.doWithRetry(req)
	if err != nil {
		return fmt.Errorf("delete routine: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		return fmt.Errorf("delete routine returned status %d", resp.StatusCode)
	}
	return nil
}

func (c *RoutinesClient) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.authToken)
	req.Header.Set("User-Agent", "routines-e2e-probe/1.0")
	req.Header.Set("X-Request-Id", generateRequestID())
	return req, nil
}

func (c *RoutinesClient) doWithRetry(req *http.Request) (*http.Response, error) {
	resp, err := c.httpClient.Do(req)
	if err != nil {
		time.Sleep(500 * time.Millisecond)
		resp, err = c.httpClient.Do(req)
		if err != nil {
			return nil, err
		}
		return resp, nil
	}

	if resp.StatusCode == http.StatusTooManyRequests {
		resp.Body.Close()
		delay := time.Second
		if ra := resp.Header.Get("Retry-After"); ra != "" {
			if secs, parseErr := strconv.Atoi(ra); parseErr == nil {
				delay = time.Duration(secs) * time.Second
			}
		}
		if delay > time.Second {
			delay = time.Second
		}
		time.Sleep(delay)
		return c.httpClient.Do(req)
	}

	if resp.StatusCode >= 500 {
		resp.Body.Close()
		time.Sleep(time.Second)
		return c.httpClient.Do(req)
	}

	return resp, nil
}

var requestCounter uint64

func generateRequestID() string {
	requestCounter++
	return fmt.Sprintf("probe-%d-%d", time.Now().UnixNano(), requestCounter)
}
