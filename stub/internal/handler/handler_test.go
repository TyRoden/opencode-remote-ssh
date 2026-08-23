package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/opencode-ai/opencode-remote-stub/internal/state"
)

func newTestHandler(t *testing.T) *Handler {
	t.Helper()
	s := state.New(t.TempDir())
	if err := s.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	return New("token", s)
}

// createWorkspaceSession seeds a workspace + session and returns their IDs.
func createWorkspaceSession(t *testing.T, h *Handler) (string, string) {
	t.Helper()
	ws := &state.Workspace{ID: "ws1", Type: "ssh-provider", Name: "w"}
	h.st.CreateWorkspace(ws)
	se := &state.Session{ID: "sess1", WorkspaceID: "ws1", Directory: "/srv/app"}
	h.st.CreateSession(se)
	return ws.ID, se.ID
}

func doShell(t *testing.T, h *Handler, command, cwd string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"command": command, "cwd": cwd})
	r := httptest.NewRequest(http.MethodPost, "/session/sess1/shell", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.Shell(w, r)
	return w
}

func doReply(t *testing.T, h *Handler, requestID, reply string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"reply": reply})
	r := httptest.NewRequest(http.MethodPost, "/permission/"+requestID+"/reply", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.PermissionReply(w, r)
	return w
}

func approve(t *testing.T, h *Handler, reply string) {
	t.Helper()
	w1 := doShell(t, h, "true", "/srv/app")
	if w1.Code != http.StatusForbidden {
		t.Fatalf("expected 403 on unapproved run, got %d", w1.Code)
	}
	reqs := h.st.ListPermissions()
	if len(reqs) != 1 {
		t.Fatalf("expected one pending permission request, got %d", len(reqs))
	}
	w := doReply(t, h, reqs[0].ID, reply)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 approving %q, got %d", reply, w.Code)
	}
}

// --- Shell permission flow ---

func TestShell_UnapprovedPathCreatesRequestAndReturns403(t *testing.T) {
	h := newTestHandler(t)
	createWorkspaceSession(t, h)

	w := doShell(t, h, "ls", "/srv/app")
	if w.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for unapproved path, got %d", w.Code)
	}
	if len(h.st.ListPermissions()) != 1 {
		t.Fatalf("expected one pending permission request, got %d", len(h.st.ListPermissions()))
	}
}

func TestShell_OnceApprovalExecutesExactlyOnce(t *testing.T) {
	h := newTestHandler(t)
	createWorkspaceSession(t, h)
	approve(t, h, "once")

	// First run after approval: executes.
	w1 := doShell(t, h, "true", "/srv/app")
	if w1.Code != http.StatusOK {
		t.Fatalf("expected 200 after 'once' approval, got %d", w1.Code)
	}
	// Second run: the 'once' approval was consumed → 403 again.
	w2 := doShell(t, h, "true", "/srv/app")
	if w2.Code != http.StatusForbidden {
		t.Fatalf("expected 403 after 'once' approval is consumed, got %d", w2.Code)
	}
}

func TestShell_AlwaysApprovalExecutesRepeatedly(t *testing.T) {
	h := newTestHandler(t)
	createWorkspaceSession(t, h)
	approve(t, h, "always")

	for i := 0; i < 3; i++ {
		w := doShell(t, h, "true", "/srv/app")
		if w.Code != http.StatusOK {
			t.Fatalf("iteration %d: expected 200 with 'always' approval, got %d", i, w.Code)
		}
	}
}

func TestShell_RunCommandCapturesExitCode(t *testing.T) {
	h := newTestHandler(t)
	createWorkspaceSession(t, h)

	if err := h.st.CreateApproval(&state.Approval{
		ID: "apr1", WorkspaceID: "ws1", Host: "default",
		Permission: "path.access", Pattern: "/tmp/**", Mode: "always",
	}); err != nil {
		t.Fatalf("CreateApproval: %v", err)
	}

	w := doShell(t, h, "exit 7", "/tmp")
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var resp struct {
		Output   string `json:"output"`
		Metadata struct {
			ExitCode int `json:"exitCode"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode shell response: %v (body: %s)", err, w.Body.String())
	}
	if resp.Metadata.ExitCode != 7 {
		t.Fatalf("expected exitCode 7, got %d", resp.Metadata.ExitCode)
	}
}

// --- PermissionReply safety ---

func TestPermissionReply_EmptyPatternsDoesNotPanic(t *testing.T) {
	h := newTestHandler(t)
	createWorkspaceSession(t, h)

	h.st.CreatePermission(&state.PermissionRequest{
		ID: "perm1", SessionID: "sess1", WorkspaceID: "ws1",
		Permission: "path.access", Patterns: []string{}, Status: "pending",
	})

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("PermissionReply panicked: %v", r)
		}
	}()
	w := doReply(t, h, "perm1", "always")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for empty-patterns approval reply, got %d", w.Code)
	}
}

func TestPermissionReply_UnknownRequestReturns404(t *testing.T) {
	h := newTestHandler(t)
	w := doReply(t, h, "does-not-exist", "always")
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown request, got %d", w.Code)
	}
}

func TestSessionPermissionReply_AppliesReplyForSessionPermission(t *testing.T) {
	h := newTestHandler(t)
	createWorkspaceSession(t, h)
	if err := h.st.CreatePermission(&state.PermissionRequest{
		ID: "perm1", SessionID: "sess1", WorkspaceID: "ws1",
		Permission: "path.access", Patterns: []string{"/srv/app/**"}, Status: "pending",
	}); err != nil {
		t.Fatalf("CreatePermission: %v", err)
	}

	body, _ := json.Marshal(map[string]string{"reply": "always"})
	r := httptest.NewRequest(http.MethodPost, "/session/sess1/permissions/perm1", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.SessionPermissionReply(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	perm, ok := h.st.GetPermission("perm1")
	if !ok || perm.Status != "always" {
		t.Fatalf("expected permission status to be updated to always, got %#v", perm)
	}
}

func TestSessionPermissionReply_RejectsWrongSession(t *testing.T) {
	h := newTestHandler(t)
	createWorkspaceSession(t, h)
	if err := h.st.CreateSession(&state.Session{ID: "sess2", WorkspaceID: "ws1", Directory: "/srv/other"}); err != nil {
		t.Fatalf("CreateSession sess2: %v", err)
	}
	if err := h.st.CreatePermission(&state.PermissionRequest{
		ID: "perm1", SessionID: "sess1", WorkspaceID: "ws1",
		Permission: "path.access", Patterns: []string{"/srv/app/**"}, Status: "pending",
	}); err != nil {
		t.Fatalf("CreatePermission: %v", err)
	}

	body, _ := json.Marshal(map[string]string{"reply": "always"})
	r := httptest.NewRequest(http.MethodPost, "/session/sess2/permissions/perm1", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.SessionPermissionReply(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for mismatched session/permission, got %d", w.Code)
	}
}

// --- Misc endpoints ---

func TestEventsStream_HasSSEHeaders(t *testing.T) {
	h := newTestHandler(t)
	// httptest.ResponseRecorder implements http.Flusher, so Events enters its
	// select loop. Cancel the request context to make it return, and run the
	// handler in a goroutine so the test cannot hang.
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest(http.MethodGet, "/global/event", nil).WithContext(ctx)
	w := httptest.NewRecorder()

	done := make(chan struct{})
	go func() {
		h.Events(w, r)
		close(done)
	}()

	time.Sleep(50 * time.Millisecond) // let the handler write headers
	cancel()
	<-done

	if got := w.Header().Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("expected text/event-stream, got %q", got)
	}
}

func TestEventBus_UnsubscribeStopsDelivery(t *testing.T) {
	b := newEventBus()
	ch := b.Subscribe()
	b.Unsubscribe(ch)

	b.Publish("test", map[string]interface{}{"k": "v"})

	select {
	case data := <-ch:
		t.Fatalf("listener received an event after unsubscribe: %s", data)
	default:
	}

	// Unsubscribing twice must be a safe no-op.
	b.Unsubscribe(ch)
}

func TestEventBus_SubscribedListenerReceivesPublish(t *testing.T) {
	b := newEventBus()
	ch := b.Subscribe()
	b.Publish("test", map[string]interface{}{"k": "v"})

	data, ok := <-ch
	if !ok {
		t.Fatal("expected the subscribed listener to receive the published event")
	}
	if !bytes.Contains(data, []byte("test")) {
		t.Fatalf("expected event payload to contain the event type, got %s", data)
	}
}

func TestWorkspaceSessionRestore_ReturnsSessionsForWorkspace(t *testing.T) {
	h := newTestHandler(t)
	if err := h.st.CreateWorkspace(&state.Workspace{ID: "ws1", Type: "ssh-provider", Name: "one"}); err != nil {
		t.Fatalf("CreateWorkspace ws1: %v", err)
	}
	if err := h.st.CreateWorkspace(&state.Workspace{ID: "ws2", Type: "ssh-provider", Name: "two"}); err != nil {
		t.Fatalf("CreateWorkspace ws2: %v", err)
	}
	if err := h.st.CreateSession(&state.Session{ID: "sess1", WorkspaceID: "ws1", Title: "A", Directory: "/srv/a", CreatedAt: 1, UpdatedAt: 2, Status: state.SessionStatus{Type: "idle"}}); err != nil {
		t.Fatalf("CreateSession sess1: %v", err)
	}
	if err := h.st.CreateSession(&state.Session{ID: "sess2", WorkspaceID: "ws1", Title: "B", Directory: "/srv/b", CreatedAt: 3, UpdatedAt: 4, Status: state.SessionStatus{Type: "busy"}}); err != nil {
		t.Fatalf("CreateSession sess2: %v", err)
	}
	if err := h.st.CreateSession(&state.Session{ID: "sess3", WorkspaceID: "ws2", Title: "C", Directory: "/srv/c", CreatedAt: 5, UpdatedAt: 6, Status: state.SessionStatus{Type: "idle"}}); err != nil {
		t.Fatalf("CreateSession sess3: %v", err)
	}

	r := httptest.NewRequest(http.MethodPost, "/experimental/workspace/ws1/session-restore", nil)
	w := httptest.NewRecorder()
	h.WorkspaceSessionRestore("ws1", w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var body []map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode restore body: %v", err)
	}
	if len(body) != 2 {
		t.Fatalf("expected 2 sessions for workspace ws1, got %d", len(body))
	}
	for _, item := range body {
		if item["workspaceID"] != "ws1" {
			t.Fatalf("restore returned session from wrong workspace: %#v", item)
		}
	}
}

func TestWorkspaceSessionRestore_UnknownWorkspaceReturns404(t *testing.T) {
	h := newTestHandler(t)
	r := httptest.NewRequest(http.MethodPost, "/experimental/workspace/missing/session-restore", nil)
	w := httptest.NewRecorder()
	h.WorkspaceSessionRestore("missing", w, r)
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", w.Code)
	}
}

func TestHealth_ReturnsOK(t *testing.T) {
	h := newTestHandler(t)
	r := httptest.NewRequest(http.MethodGet, "/global/health", nil)
	w := httptest.NewRecorder()
	h.Health(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var body map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode health body: %v", err)
	}
	if body["ok"] != true {
		t.Fatalf("expected ok=true in health body, got %v", body)
	}
}
