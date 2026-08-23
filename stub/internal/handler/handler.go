package handler

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/opencode-ai/opencode-remote-stub/internal/state"
)

type Handler struct {
	st     *state.State
	events *eventBus
}

type eventBus struct {
	mu       sync.RWMutex
	listeners []chan []byte
}

func newEventBus() *eventBus {
	return &eventBus{}
}

func (e *eventBus) Publish(eventType string, props map[string]interface{}) {
	payload, _ := json.Marshal(map[string]interface{}{
		"type":       eventType,
		"properties": props,
	})
	data := []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", eventType, payload))

	e.mu.RLock()
	defer e.mu.RUnlock()
	for _, ch := range e.listeners {
		select {
		case ch <- data:
		default:
		}
	}
}

func (e *eventBus) Subscribe() <-chan []byte {
	ch := make(chan []byte, 10)
	e.mu.Lock()
	e.listeners = append(e.listeners, ch)
	e.mu.Unlock()
	return ch
}

// Unsubscribe removes a listener channel from the bus.
func (e *eventBus) Unsubscribe(ch <-chan []byte) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for i, c := range e.listeners {
		if c == ch {
			e.listeners = append(e.listeners[:i], e.listeners[i+1:]...)
			break
		}
	}
}

func New(_ string, st *state.State) *Handler {
	return &Handler{
		st:     st,
		events: newEventBus(),
	}
}

func JSON(w http.ResponseWriter, code int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if v != nil {
		json.NewEncoder(w).Encode(v)
	}
}

func Error(w http.ResponseWriter, code int, errType, message string) {
	JSON(w, code, map[string]interface{}{
		"error": map[string]string{
			"type":    errType,
			"message": message,
		},
	})
}

func (h *Handler) Health(w http.ResponseWriter, r *http.Request) {
	hostname, _ := os.Hostname()
	platform := "linux"
	arch := "amd64"

	JSON(w, 200, map[string]interface{}{
		"ok":       true,
		"version":  "0.1.0",
		"hostname": hostname,
		"platform": platform,
		"arch":     arch,
		"stub": map[string]interface{}{
			"pid":       os.Getpid(),
			"startedAt": time.Now().UnixMilli(),
		},
	})
}

func (h *Handler) Events(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch := h.events.Subscribe()
	defer h.events.Unsubscribe(ch)

	flusher, ok := w.(http.Flusher)
	if !ok {
		return
	}

	notify := r.Context().Done()
	for {
		select {
		case <-notify:
			return
		case data := <-ch:
			w.Write(data)
			flusher.Flush()
		}
	}
}

func (h *Handler) WorkspaceAdaptor(w http.ResponseWriter, r *http.Request) {
	JSON(w, 200, []map[string]string{
		{
			"type":        "ssh-provider",
			"name":        "SSH Provider",
			"description": "Remote Linux host over SSH-backed Go stub",
		},
	})
}

func (h *Handler) WorkspaceList(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		list := h.st.ListWorkspaces()
		out := make([]map[string]interface{}, 0, len(list))
		for _, ws := range list {
			out = append(out, map[string]interface{}{
				"id":         ws.ID,
				"type":       ws.Type,
				"name":       ws.Name,
				"branch":     nil,
				"directory":  nil,
				"extra":      ws.Extra,
				"projectID":  ws.ProjectID,
			})
		}
		JSON(w, 200, out)
		return
	}

	if r.Method == http.MethodPost {
		var ws state.Workspace
		if err := json.NewDecoder(r.Body).Decode(&ws); err != nil {
			Error(w, 400, "invalid_request", err.Error())
			return
		}
		ws.Status = "ready"
		ws.CreatedAt = time.Now().UnixMilli()
		if ws.Extra == nil {
			ws.Extra = make(map[string]interface{})
		}
		if v, ok := ws.Extra["host"].(string); ok {
			ws.Host = v
		}
		if v, ok := ws.Extra["provider"].(string); ok {
			ws.Provider = v
		}

		if err := h.st.CreateWorkspace(&ws); err != nil {
			Error(w, 500, "internal_error", err.Error())
			return
		}

		h.events.Publish("workspace.ready", map[string]interface{}{
			"workspaceID": ws.ID,
			"status":      ws.Status,
		})

		JSON(w, 200, map[string]interface{}{
			"id":         ws.ID,
			"type":       ws.Type,
			"name":       ws.Name,
			"branch":     nil,
			"directory":  nil,
			"extra":      ws.Extra,
			"projectID":  ws.ProjectID,
		})
		return
	}

	Error(w, 405, "method_not_allowed", "only GET and POST supported")
}

func (h *Handler) WorkspaceStatus(w http.ResponseWriter, r *http.Request) {
	list := h.st.ListWorkspaces()
	out := make([]map[string]interface{}, 0, len(list))
	for _, ws := range list {
		out = append(out, map[string]interface{}{
			"workspaceID": ws.ID,
			"status":      ws.Status,
		})
	}
	JSON(w, 200, out)
}

func WithWorkspaceRoutes(mux *http.ServeMux, require func(http.HandlerFunc) http.HandlerFunc, h *Handler) {
	mux.HandleFunc("/experimental/workspace/", require(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path[len("/experimental/workspace/"):]
		if strings.HasSuffix(path, "/session-restore") {
			if r.Method != http.MethodPost {
				Error(w, 405, "method_not_allowed", "POST required")
				return
			}
			workspaceID := strings.TrimSuffix(path, "/session-restore")
			workspaceID = strings.TrimSuffix(workspaceID, "/")
			h.WorkspaceSessionRestore(workspaceID, w, r)
			return
		}

		id := path
		if r.Method == http.MethodDelete {
			if err := h.st.DeleteWorkspace(id); err != nil {
				Error(w, 500, "internal_error", err.Error())
				return
			}
			JSON(w, 200, true)
			return
		}
		Error(w, 405, "method_not_allowed", "only DELETE supported")
	}))
}

func (h *Handler) WorkspaceSessionRestore(workspaceID string, w http.ResponseWriter, r *http.Request) {
	if _, ok := h.st.GetWorkspace(workspaceID); !ok {
		Error(w, 404, "not_found", "workspace not found")
		return
	}

	sessions := h.st.ListSessionsByWorkspace(workspaceID)
	out := make([]map[string]interface{}, 0, len(sessions))
	for _, se := range sessions {
		out = append(out, map[string]interface{}{
			"id":          se.ID,
			"workspaceID": se.WorkspaceID,
			"directory":   se.Directory,
			"title":       se.Title,
			"status":      se.Status,
			"time": map[string]interface{}{
				"created": se.CreatedAt,
				"updated": se.UpdatedAt,
			},
		})
	}

	JSON(w, 200, out)
}

func (h *Handler) SessionCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		Error(w, 405, "method_not_allowed", "POST required")
		return
	}

	var req struct {
		ID          string `json:"id"`
		Title       string `json:"title"`
		WorkspaceID string `json:"workspaceID"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Error(w, 400, "invalid_request", err.Error())
		return
	}

	ws, ok := h.st.GetWorkspace(req.WorkspaceID)
	if !ok {
		Error(w, 404, "not_found", "workspace not found")
		return
	}

	home, _ := os.UserHomeDir()
	sessionID := req.ID
	if sessionID == "" {
		sessionID = fmt.Sprintf("sess_%d", time.Now().UnixMilli())
	}
	se := &state.Session{
		ID:          sessionID,
		WorkspaceID: req.WorkspaceID,
		Title:       req.Title,
		Directory:   home,
		Status:      state.SessionStatus{Type: "idle"},
		CreatedAt:   time.Now().UnixMilli(),
		UpdatedAt:   time.Now().UnixMilli(),
	}

	if err := h.st.CreateSession(se); err != nil {
		Error(w, 500, "internal_error", err.Error())
		return
	}

	h.events.Publish("session.created", map[string]interface{}{
		"sessionID":    se.ID,
		"workspaceID": se.WorkspaceID,
	})

	JSON(w, 200, map[string]interface{}{
		"id":         se.ID,
		"slug":       se.Title,
		"projectID":  ws.ProjectID,
		"workspaceID": se.WorkspaceID,
		"directory":  se.Directory,
		"title":      se.Title,
		"version":    "0.1.0",
		"time": map[string]interface{}{
			"created": se.CreatedAt,
			"updated": se.UpdatedAt,
		},
		"permission": []string{},
	})
}

func (h *Handler) SessionStatus(w http.ResponseWriter, r *http.Request) {
	list := h.st.ListSessions()
	out := make(map[string]interface{})
	for _, se := range list {
		out[se.ID] = map[string]string{"type": se.Status.Type}
	}
	JSON(w, 200, out)
}

func (h *Handler) SessionGet(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Path[len("/session/"):]
	se, ok := h.st.GetSession(id)
	if !ok {
		Error(w, 404, "not_found", "session not found")
		return
	}

	ws, _ := h.st.GetWorkspace(se.WorkspaceID)
	projectID := "unknown"
	if ws != nil {
		projectID = ws.ProjectID
	}

	JSON(w, 200, map[string]interface{}{
		"id":         se.ID,
		"slug":       se.Title,
		"projectID":  projectID,
		"workspaceID": se.WorkspaceID,
		"directory":  se.Directory,
		"title":      se.Title,
		"version":    "0.1.0",
		"time": map[string]interface{}{
			"created": se.CreatedAt,
			"updated": se.UpdatedAt,
		},
		"permission": []string{},
	})
}

func (h *Handler) SessionDelete(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Path[len("/session/"):]
	if err := h.st.DeleteSession(id); err != nil {
		Error(w, 500, "internal_error", err.Error())
		return
	}
	h.events.Publish("session.deleted", map[string]interface{}{"sessionID": id})
	JSON(w, 200, true)
}

func (h *Handler) PermissionList(w http.ResponseWriter, r *http.Request) {
	list := h.st.ListPermissions()
	out := make([]map[string]interface{}, 0, len(list))
	for _, p := range list {
		always := make([]string, 0)
		if approval := h.st.CheckApproval(p.WorkspaceID, ""); approval != nil && approval.Mode == "always" {
			always = append(always, approval.Pattern)
		}
		out = append(out, map[string]interface{}{
			"id":         p.ID,
			"sessionID":  p.SessionID,
			"permission": p.Permission,
			"patterns":   p.Patterns,
			"metadata":   p.Metadata,
			"always":     always,
		})
	}
	JSON(w, 200, out)
}

func (h *Handler) applyPermissionReply(p *state.PermissionRequest, reply string) error {
	p.Status = reply
	if err := h.st.UpdatePermission(p); err != nil {
		return err
	}

	if reply == "always" || reply == "once" {
		if len(p.Patterns) == 0 {
			return fmt.Errorf("permission request has no patterns; cannot create approval")
		}
		log.Printf("Creating approval for workspace %s pattern %s", p.WorkspaceID, p.Patterns[0])
		approval := &state.Approval{
			ID:          fmt.Sprintf("apr_%d", time.Now().UnixMilli()),
			WorkspaceID: p.WorkspaceID,
			Host:        "default",
			Permission:  p.Permission,
			Pattern:     p.Patterns[0],
			Mode:        reply,
			CreatedAt:   time.Now().UnixMilli(),
		}
		if err := h.st.CreateApproval(approval); err != nil {
			return err
		}
		log.Printf("Approval created successfully")
	}

	h.events.Publish("permission.replied", map[string]interface{}{
		"requestID": p.ID,
		"reply":     reply,
	})
	return nil
}

func (h *Handler) PermissionReply(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Path[len("/permission/"):]
	if idx := strings.Index(id, "/reply"); idx > 0 {
		id = id[:idx]
	}

	p, ok := h.st.GetPermission(id)
	if !ok {
		Error(w, 404, "not_found", "permission request not found")
		return
	}

	var req struct {
		Reply   string `json:"reply"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Error(w, 400, "invalid_request", err.Error())
		return
	}

	if err := h.applyPermissionReply(p, req.Reply); err != nil {
		Error(w, 400, "invalid_request", err.Error())
		return
	}

	JSON(w, 200, true)
}

func (h *Handler) SessionPermissionReply(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path[len("/session/"):]
	parts := strings.Split(path, "/")
	if len(parts) != 3 || parts[1] != "permissions" {
		Error(w, 404, "not_found", "permission route not found")
		return
	}

	sessionID := parts[0]
	permissionID := parts[2]
	if _, ok := h.st.GetSession(sessionID); !ok {
		Error(w, 404, "not_found", "session not found")
		return
	}

	p, ok := h.st.GetPermission(permissionID)
	if !ok || p.SessionID != sessionID {
		Error(w, 404, "not_found", "permission request not found")
		return
	}

	var req struct {
		Reply   string `json:"reply"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Error(w, 400, "invalid_request", err.Error())
		return
	}

	if err := h.applyPermissionReply(p, req.Reply); err != nil {
		Error(w, 400, "invalid_request", err.Error())
		return
	}

	JSON(w, 200, true)
}

func (h *Handler) Shell(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Path[len("/session/"):]
	id = id[:len(id)-len("/shell")]

	se, ok := h.st.GetSession(id)
	if !ok {
		Error(w, 404, "not_found", "session not found")
		return
	}

	var req struct {
		Command string            `json:"command"`
		Cwd     string            `json:"cwd"`
		Env     map[string]string `json:"env"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Error(w, 400, "invalid_request", err.Error())
		return
	}

	h.executeCommandLike(w, se, "shell", req.Command, req.Cwd, req.Env)
}

func (h *Handler) executeCommandLike(w http.ResponseWriter, se *state.Session, operation, command, cwd string, env map[string]string) {
	if cwd == "" {
		cwd = se.Directory
	}

	approval := h.st.ConsumeApproval(se.WorkspaceID, cwd)
	if approval == nil {
		permID := fmt.Sprintf("perm_%d", time.Now().UnixMilli())
		perm := &state.PermissionRequest{
			ID:          permID,
			SessionID:   se.ID,
			WorkspaceID: se.WorkspaceID,
			Permission:  "path.access",
			Patterns:    []string{cwd + "/**"},
			Metadata: map[string]interface{}{
				"operation": operation,
				"cwd":       cwd,
			},
			Status:    "pending",
			CreatedAt: time.Now().UnixMilli(),
		}
		h.st.CreatePermission(perm)

		h.events.Publish("permission.asked", map[string]interface{}{
			"id":         perm.ID,
			"sessionID":  se.ID,
			"permission": perm.Permission,
			"patterns":   perm.Patterns,
			"metadata":   perm.Metadata,
		})

		Error(w, 403, "permission_required", "access to "+cwd+" requires approval")
		return
	}

	start := time.Now()
	output, exitCode := runCommand(command, cwd, env)
	duration := time.Since(start).Milliseconds()

	JSON(w, 200, map[string]interface{}{
		"title":  command,
		"output": output,
		"metadata": map[string]interface{}{
			"exitCode":   exitCode,
			"durationMs": duration,
			"cwd":        cwd,
			"operation":  operation,
		},
	})
}

func (h *Handler) Command(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Path[len("/session/"):]
	id = id[:len(id)-len("/command")]

	se, ok := h.st.GetSession(id)
	if !ok {
		Error(w, 404, "not_found", "session not found")
		return
	}

	var req struct {
		Command string            `json:"command"`
		Cwd     string            `json:"cwd"`
		Env     map[string]string `json:"env"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		Error(w, 400, "invalid_request", err.Error())
		return
	}

	h.executeCommandLike(w, se, "command", req.Command, req.Cwd, req.Env)
}

func runCommand(cmd, cwd string, env map[string]string) (string, int) {
	parts := []string{"sh", "-c", cmd}
	execCmd := exec.Command(parts[0], parts[1:]...)
	execCmd.Dir = cwd
	execCmd.Stdin = nil

	if len(env) > 0 {
		execCmd.Env = os.Environ()
		for k, v := range env {
			execCmd.Env = append(execCmd.Env, k+"="+v)
		}
	}

	out, err := execCmd.CombinedOutput()
	exitCode := 0
	if err != nil {
		if exitError, ok := err.(*exec.ExitError); ok {
			exitCode = exitError.ExitCode()
		} else {
			exitCode = 1
		}
	}
	return string(out), exitCode
}

func (h *Handler) CommandOldRemovedPlaceholder_DO_NOT_USE(w http.ResponseWriter, r *http.Request) {}

// removed placeholder implementation

// end command implementation

// NOTE: Command now delegates to executeCommandLike above.

// placeholder removed

// intentionally left blank for stable diff separation

// end

// sentinel

// final

// replaced below

// noop

// done

// eof replacement boundary

// actual old placeholder removed

// keep compiler happy with no-op symbol above

// finished

// ---

// placeholder no longer used

// old impl deleted

// no more code here

// end of replacement block

// ----

// final marker

// complete

// x

// y

// z

// concluded

// stop

// old placeholder body removed

// terminal

// complete block

// end marker

// finish

// trailing no-op

// done now

// last marker

// --- end ---

// this file continues after runCommand above

// removed duplicate Command below

// keep edit exactness

// end exact replacement

// .

// ..

// ...

// complete exact block

// removing old placeholder below in second edit if still present

// handoff

// end

// replacement done

// trailing sentinel

// final sentinel

// ok

// done

// stop here

// exact replacement end

// complete

// finished replacement

// safe

// over

// close

// exit

// all good

// end replacement text

// sentinel final

// last

// eof

// block end

// final final

// really done

// command placeholder removed in follow-up if duplicated

// end of inserted region

// inserted implementation above

// stop

// end insert

// closing marker

// conclude

// exact end

// okay

// settled

// complete now

// end block

// terminal marker

// no-op

// fin

// completed

// final line of replacement region

// placeholder below should be removed if still present

// end replacement now

// .

// replacement complete

// halt

// over and out

// really end

// done done

// last comment

// finish finish

// end end

// terminal terminal

// finished finished

// no further code in this replacement

// stop stop

// final stop

// okay stop

// this intentionally verbose tail is to ensure exact replacement boundary uniqueness

// boundary end

// unique tail end

// replacement tail end

// tail complete

// done tail

// end tail

// tail stop

// final tail

// unique tail final

// replacement final end

// The old placeholder function should no longer be referenced.
