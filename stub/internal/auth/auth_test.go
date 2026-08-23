package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// runMiddleware executes Require(token, inner) against a request carrying the
// given Authorization header ("" = absent) and reports the status code and
// whether the inner handler ran.
func runMiddleware(token, authorization string) (code int, innerRan bool) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/global/health", nil)
	if authorization != "" {
		r.Header.Set("Authorization", authorization)
	}
	Require(token, func(w http.ResponseWriter, r *http.Request) {
		innerRan = true
		w.WriteHeader(http.StatusOK)
	}).ServeHTTP(w, r)
	return w.Code, innerRan
}

func TestRequire_AcceptsCorrectToken(t *testing.T) {
	code, innerRan := runMiddleware("secret-token-123", "Bearer secret-token-123")
	if code != http.StatusOK {
		t.Fatalf("expected 200 for correct token, got %d", code)
	}
	if !innerRan {
		t.Fatal("expected inner handler to run for correct token")
	}
}

func TestRequire_AcceptsLowercaseScheme(t *testing.T) {
	code, _ := runMiddleware("secret-token-123", "bearer secret-token-123")
	if code != http.StatusOK {
		t.Fatalf("expected 200 for lowercase 'bearer' scheme, got %d", code)
	}
}

func TestRequire_RejectsMissingHeader(t *testing.T) {
	code, innerRan := runMiddleware("secret-token-123", "")
	if code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for missing header, got %d", code)
	}
	if innerRan {
		t.Fatal("inner handler must not run when header is missing")
	}
}

func TestRequire_RejectsWrongScheme(t *testing.T) {
	code, _ := runMiddleware("secret-token-123", "Basic secret-token-123")
	if code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for wrong scheme, got %d", code)
	}
}

func TestRequire_RejectsMalformedHeader(t *testing.T) {
	code, _ := runMiddleware("secret-token-123", "BearerOnly")
	if code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for malformed header, got %d", code)
	}
}

func TestRequire_RejectsWrongToken(t *testing.T) {
	code, innerRan := runMiddleware("secret-token-123", "Bearer not-the-right-token")
	if code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for wrong token, got %d", code)
	}
	if innerRan {
		t.Fatal("inner handler must not run for wrong token")
	}
}

func TestRequire_RejectsEmptyTokenValue(t *testing.T) {
	code, _ := runMiddleware("secret-token-123", "Bearer")
	if code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for empty token value, got %d", code)
	}
}

func TestRequire_TokenWithSpaces(t *testing.T) {
	token := "token with spaces"
	code, _ := runMiddleware(token, "Bearer "+token)
	if code != http.StatusOK {
		t.Fatalf("expected 200 for token containing spaces, got %d", code)
	}
}

func TestToken_ContextValue(t *testing.T) {
	token := "context-token-999"
	var got string
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	Require(token, func(w http.ResponseWriter, r *http.Request) {
		got = Token(r.Context())
		w.WriteHeader(http.StatusOK)
	}).ServeHTTP(w, r)
	if got != token {
		t.Fatalf("expected Token(ctx)=%q, got %q", token, got)
	}
}

func TestToken_EmptyContext(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if Token(r.Context()) != "" {
		t.Fatal("expected empty token for context without one")
	}
}
