package state

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

type State struct {
	mu          sync.RWMutex
	root        string
	workspaces  map[string]*Workspace
	sessions    map[string]*Session
	permissions map[string]*PermissionRequest
	approvals   map[string]*Approval
}

type Workspace struct {
	ID        string                 `json:"id"`
	Type      string                 `json:"type"`
	Name      string                 `json:"name"`
	ProjectID string                 `json:"projectID"`
	Provider  string                 `json:"provider"`
	Host      string                 `json:"host"`
	Status    string                 `json:"status"`
	CreatedAt int64                  `json:"createdAt"`
	Extra     map[string]interface{} `json:"extra,omitempty"`
}

type Session struct {
	ID          string                 `json:"id"`
	WorkspaceID string                 `json:"workspaceID"`
	Title       string                 `json:"title"`
	Directory   string                 `json:"directory"`
	Status      SessionStatus          `json:"status"`
	CreatedAt   int64                  `json:"createdAt"`
	UpdatedAt   int64                  `json:"updatedAt"`
}

type SessionStatus struct {
	Type    string `json:"type"`
	Message string `json:"message,omitempty"`
}

type PermissionRequest struct {
	ID          string                 `json:"id"`
	SessionID   string                 `json:"sessionID"`
	WorkspaceID string                 `json:"workspaceID"`
	Permission  string                 `json:"permission"`
	Patterns    []string              `json:"patterns"`
	Metadata    map[string]interface{} `json:"metadata"`
	Always      []string              `json:"always"`
	Status      string                 `json:"status"`
	CreatedAt   int64                  `json:"createdAt"`
}

type Approval struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspaceID"`
	Host        string   `json:"host"`
	Permission  string   `json:"permission"`
	Pattern     string   `json:"pattern"`
	Mode        string   `json:"mode"` // "once" or "always"
	CreatedAt   int64    `json:"createdAt"`
}

func New(root string) *State {
	return &State{
		root:        root,
		workspaces:  make(map[string]*Workspace),
		sessions:    make(map[string]*Session),
		permissions: make(map[string]*PermissionRequest),
		approvals:   make(map[string]*Approval),
	}
}

func (s *State) Init() error {
	dirs := []string{
		filepath.Join(s.root, "workspaces"),
		filepath.Join(s.root, "sessions"),
		filepath.Join(s.root, "approvals"),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0755); err != nil {
			return err
		}
	}
	s.loadAll()
	return nil
}

func (s *State) loadAll() {
	s.loadWorkspaces()
	s.loadSessions()
	s.loadApprovals()
}

func (s *State) loadWorkspaces() {
	path := filepath.Join(s.root, "workspaces")
	entries, _ := os.ReadDir(path)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		data, _ := os.ReadFile(filepath.Join(path, e.Name(), "workspace.json"))
		var ws Workspace
		if json.Unmarshal(data, &ws) == nil {
			s.workspaces[ws.ID] = &ws
		}
	}
}

func (s *State) loadSessions() {
	path := filepath.Join(s.root, "sessions")
	entries, _ := os.ReadDir(path)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		data, _ := os.ReadFile(filepath.Join(path, e.Name()))
		var sess Session
		if json.Unmarshal(data, &sess) == nil {
			s.sessions[sess.ID] = &sess
		}
	}
}

func (s *State) loadApprovals() {
	path := filepath.Join(s.root, "approvals")
	entries, _ := os.ReadDir(path)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		data, _ := os.ReadFile(filepath.Join(path, e.Name()))
		var apr Approval
		if json.Unmarshal(data, &apr) == nil {
			s.approvals[apr.ID] = &apr
		}
	}
}

func (s *State) GetWorkspace(id string) (*Workspace, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ws, ok := s.workspaces[id]
	return ws, ok
}

func (s *State) ListWorkspaces() []*Workspace {
	s.mu.RLock()
	defer s.mu.RUnlock()
	list := make([]*Workspace, 0, len(s.workspaces))
	for _, ws := range s.workspaces {
		list = append(list, ws)
	}
	return list
}

func (s *State) CreateWorkspace(ws *Workspace) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.workspaces[ws.ID] = ws
	return s.saveWorkspace(ws)
}

func (s *State) DeleteWorkspace(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.workspaces, id)
	os.RemoveAll(filepath.Join(s.root, "workspaces", id))
	return nil
}

func (s *State) saveWorkspace(ws *Workspace) error {
	dir := filepath.Join(s.root, "workspaces", ws.ID)
	os.MkdirAll(dir, 0755)
	data, _ := json.Marshal(ws)
	return os.WriteFile(filepath.Join(dir, "workspace.json"), data, 0644)
}

func (s *State) GetSession(id string) (*Session, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	se, ok := s.sessions[id]
	return se, ok
}

func (s *State) ListSessions() []*Session {
	s.mu.RLock()
	defer s.mu.RUnlock()
	list := make([]*Session, 0, len(s.sessions))
	for _, se := range s.sessions {
		list = append(list, se)
	}
	return list
}

func (s *State) CreateSession(se *Session) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[se.ID] = se
	return s.saveSession(se)
}

func (s *State) UpdateSession(se *Session) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[se.ID] = se
	return s.saveSession(se)
}

func (s *State) DeleteSession(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, id)
	os.Remove(filepath.Join(s.root, "sessions", id+".json"))
	return nil
}

func (s *State) saveSession(se *Session) error {
	data, _ := json.Marshal(se)
	return os.WriteFile(filepath.Join(s.root, "sessions", se.ID+".json"), data, 0644)
}

func (s *State) ListPermissions() []*PermissionRequest {
	s.mu.RLock()
	defer s.mu.RUnlock()
	list := make([]*PermissionRequest, 0, len(s.permissions))
	for _, p := range s.permissions {
		if p.Status == "pending" {
			list = append(list, p)
		}
	}
	return list
}

func (s *State) CreatePermission(p *PermissionRequest) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.permissions[p.ID] = p
	return nil
}

func (s *State) GetPermission(id string) (*PermissionRequest, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.permissions[id]
	return p, ok
}

func (s *State) UpdatePermission(p *PermissionRequest) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.permissions[p.ID] = p
	return nil
}

func (s *State) ListApprovals(workspaceID string) []*Approval {
	s.mu.RLock()
	defer s.mu.RUnlock()
	list := make([]*Approval, 0, len(s.approvals))
	for _, a := range s.approvals {
		if a.WorkspaceID == workspaceID {
			list = append(list, a)
		}
	}
	return list
}

func (s *State) CreateApproval(a *Approval) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.approvals[a.ID] = a
	return s.saveApproval(a)
}

func (s *State) saveApproval(a *Approval) error {
	data, err := json.Marshal(a)
	if err != nil {
		return err
	}
	path := filepath.Join(s.root, "approvals", a.ID+".json")
	return os.WriteFile(path, data, 0644)
}

func (s *State) CheckApproval(workspaceID, path string) *Approval {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, a := range s.approvals {
		if a.WorkspaceID != workspaceID {
			continue
		}
		if matchPattern(a.Pattern, path) {
			return a
		}
	}
	return nil
}

func matchPattern(pattern, path string) bool {
	if pattern == path {
		return true
	}
	if len(pattern) >= 3 && pattern[len(pattern)-3:] == "/**" {
		prefix := pattern[:len(pattern)-3]
		if path == prefix || path == prefix+"/" {
			return true
		}
		if len(path) > len(prefix) && path[len(prefix)] == '/' {
			return path[:len(prefix)] == prefix
		}
		return false
	}
	if len(pattern) > 0 && pattern[len(pattern)-1] == '*' {
		prefix := pattern[:len(pattern)-1]
		return len(path) >= len(prefix) && path[:len(prefix)] == prefix
	}
	return false
}