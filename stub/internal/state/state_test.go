package state

import (
	"os"
	"path/filepath"
	"testing"
)

func newTestState(t *testing.T) *State {
	t.Helper()
	root := t.TempDir()
	s := New(root)
	if err := s.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	return s
}

func approval(id, ws, pattern, mode string) *Approval {
	return &Approval{
		ID:          id,
		WorkspaceID: ws,
		Host:        "default",
		Permission:  "path.access",
		Pattern:     pattern,
		Mode:        mode,
	}
}

func approvalFileExists(t *testing.T, root, id string) bool {
	t.Helper()
	_, err := os.Stat(filepath.Join(root, "approvals", id+".json"))
	return err == nil
}

// --- matchPattern ---

func TestMatchPattern_Exact(t *testing.T) {
	if !matchPattern("/srv/app", "/srv/app") {
		t.Error("exact match should succeed")
	}
	if matchPattern("/srv/app", "/srv/other") {
		t.Error("exact match should not succeed on a different path")
	}
}

func TestMatchPattern_Glob(t *testing.T) {
	if !matchPattern("/srv/app/**", "/srv/app") {
		t.Error("glob should match the base directory")
	}
	if !matchPattern("/srv/app/**", "/srv/app/deep/dir") {
		t.Error("glob should match descendants")
	}
	if !matchPattern("/srv/app/*", "/srv/app/sub") {
		t.Error("star should match a prefix path")
	}
	if matchPattern("/srv/app/**", "/srv/other") {
		t.Error("glob should not match unrelated paths")
	}
}

func TestMatchPattern_PathTraversalBlocked(t *testing.T) {
	if matchPattern("/srv/app/**", "/srv/other") {
		t.Error("descendant check must not allow sibling directories")
	}
}

// --- CheckApproval (read-only) ---

func TestCheckApproval_ReturnsMatch(t *testing.T) {
	s := newTestState(t)
	s.CreateApproval(approval("apr1", "ws1", "/srv/app/**", "always"))

	if a := s.CheckApproval("ws1", "/srv/app/logs"); a == nil {
		t.Fatal("expected an approval match for ws1")
	}
	if a := s.CheckApproval("ws2", "/srv/app/logs"); a != nil {
		t.Fatal("no approval expected for a different workspace")
	}
	if a := s.CheckApproval("ws1", "/unrelated"); a != nil {
		t.Fatal("no approval expected for a non-matching path")
	}
}

func TestCheckApproval_NeverConsumesOnce(t *testing.T) {
	s := newTestState(t)
	s.CreateApproval(approval("apr1", "ws1", "/srv/app/**", "once"))

	// Repeated checks must not consume the one-shot approval.
	if a := s.CheckApproval("ws1", "/srv/app"); a == nil || a.Mode != "once" {
		t.Fatal("expected a 'once' approval to be present")
	}
	if a := s.CheckApproval("ws1", "/srv/app"); a == nil || a.Mode != "once" {
		t.Fatal("second check should still see the 'once' approval (CheckApproval is read-only)")
	}
}

// --- ConsumeApproval ---

func TestConsumeApproval_AlwaysPersists(t *testing.T) {
	s := newTestState(t)
	s.CreateApproval(approval("apr1", "ws1", "/srv/app/**", "always"))

	for i := 0; i < 3; i++ {
		if a := s.ConsumeApproval("ws1", "/srv/app"); a == nil || a.Mode != "always" {
			t.Fatalf("iteration %d: expected an 'always' approval to remain available", i)
		}
	}
}

func TestConsumeApproval_OnceIsSingleUse(t *testing.T) {
	s := newTestState(t)
	s.CreateApproval(approval("apr1", "ws1", "/srv/app/**", "once"))

	if a := s.ConsumeApproval("ws1", "/srv/app"); a == nil {
		t.Fatal("first consumption should return the 'once' approval")
	}
	if a := s.ConsumeApproval("ws1", "/srv/app"); a != nil {
		t.Fatal("second consumption of a 'once' approval should return nil")
	}
}

func TestConsumeApproval_OnceRemovedFromDisk(t *testing.T) {
	root := t.TempDir()
	s := New(root)
	if err := s.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	s.CreateApproval(approval("apr1", "ws1", "/srv/app/**", "once"))
	if !approvalFileExists(t, root, "apr1") {
		t.Fatal("expected approval file on disk before consumption")
	}

	s.ConsumeApproval("ws1", "/srv/app")
	if approvalFileExists(t, root, "apr1") {
		t.Error("expected 'once' approval file to be deleted after consumption")
	}

	// A remaining 'always' approval must survive the same consumption path.
	s.CreateApproval(approval("apr2", "ws1", "/var/data/**", "always"))
	s.CreateApproval(approval("apr3", "ws1", "/srv/app/**", "once"))
	s.ConsumeApproval("ws1", "/srv/app")
	if !approvalFileExists(t, root, "apr2") {
		t.Error("unrelated 'always' approval file must remain")
	}
}

// --- persistence round-trip ---

func TestApprovals_PersistAcrossRestart(t *testing.T) {
	root := t.TempDir()
	s := New(root)
	if err := s.Init(); err != nil {
		t.Fatalf("Init: %v", err)
	}
	s.CreateApproval(approval("apr1", "ws1", "/srv/app/**", "always"))
	s.CreateApproval(approval("apr2", "ws1", "/var/data/**", "once"))

	// Simulate a stub restart: a fresh State instance over the same directory.
	s2 := New(root)
	if err := s2.Init(); err != nil {
		t.Fatalf("re-Init: %v", err)
	}

	if a := s2.CheckApproval("ws1", "/srv/app"); a == nil || a.Mode != "always" {
		t.Fatal("'always' approval should survive restart")
	}
	if a := s2.ConsumeApproval("ws1", "/var/data"); a == nil {
		t.Fatal("the reloaded 'once' approval must still be usable once")
	}
	if a := s2.ConsumeApproval("ws1", "/var/data"); a != nil {
		t.Fatal("reloaded 'once' approval must not be reusable")
	}
}

// --- workspace/session basics used by handlers ---

func TestWorkspaceCreateDelete(t *testing.T) {
	s := newTestState(t)
	ws := &Workspace{ID: "ws1", Type: "ssh-provider", Name: "w"}
	if err := s.CreateWorkspace(ws); err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	if _, ok := s.GetWorkspace("ws1"); !ok {
		t.Fatal("expected workspace to be retrievable")
	}
	if err := s.DeleteWorkspace("ws1"); err != nil {
		t.Fatalf("DeleteWorkspace: %v", err)
	}
	if _, ok := s.GetWorkspace("ws1"); ok {
		t.Fatal("expected workspace to be gone after delete")
	}
}

func TestSession_CRUD(t *testing.T) {
	s := newTestState(t)
	se := &Session{ID: "sess1", WorkspaceID: "ws1", Title: "t", Directory: "/srv/app"}
	if err := s.CreateSession(se); err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if _, ok := s.GetSession("sess1"); !ok {
		t.Fatal("expected session to be retrievable")
	}
	if err := s.DeleteSession("sess1"); err != nil {
		t.Fatalf("DeleteSession: %v", err)
	}
	if _, ok := s.GetSession("sess1"); ok {
		t.Fatal("expected session to be gone after delete")
	}
}

func TestPermissions_PendingOnlyInList(t *testing.T) {
	s := newTestState(t)
	pending := &PermissionRequest{ID: "p1", SessionID: "s", WorkspaceID: "ws1", Permission: "path.access", Patterns: []string{"/a/**"}, Status: "pending"}
	done := &PermissionRequest{ID: "p2", SessionID: "s", WorkspaceID: "ws1", Permission: "path.access", Patterns: []string{"/b/**"}, Status: "approved"}
	s.CreatePermission(pending)
	s.CreatePermission(done)

	list := s.ListPermissions()
	if len(list) != 1 || list[0].ID != "p1" {
		t.Fatalf("expected only the pending permission to be listed, got %d entries", len(list))
	}
}
