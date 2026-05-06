package auth

import (
	"context"
	"net/http"
	"strings"
)

type key int

const TokenKey key = 0

func Require(token string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if auth == "" {
			http.Error(w, `{"error":{"type":"unauthorized","message":"missing authorization header"}}`, http.StatusUnauthorized)
			return
		}

		parts := strings.SplitN(auth, " ", 2)
		if len(parts) != 2 || strings.ToLower(parts[0]) != "bearer" {
			http.Error(w, `{"error":{"type":"unauthorized","message":"invalid authorization header format"}}`, http.StatusUnauthorized)
			return
		}

		if parts[1] != token {
			http.Error(w, `{"error":{"type":"unauthorized","message":"invalid token"}}`, http.StatusUnauthorized)
			return
		}

		ctx := r.Context()
		ctx = context.WithValue(ctx, TokenKey, parts[1])
		next(w, r.WithContext(ctx))
	}
}

func Token(ctx context.Context) string {
	if v, ok := ctx.Value(TokenKey).(string); ok {
		return v
	}
	return ""
}