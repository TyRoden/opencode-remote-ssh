package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/opencode-ai/opencode-remote-stub/internal/auth"
	"github.com/opencode-ai/opencode-remote-stub/internal/handler"
	"github.com/opencode-ai/opencode-remote-stub/internal/state"
)

var (
	listenAddr  string
	tokenFile   string
	stateDir    string
	logFile     string
)

func init() {
	flag.StringVar(&listenAddr, "listen", "127.0.0.1:39217", "listen address")
	flag.StringVar(&tokenFile, "token-file", "", "path to token file")
	flag.StringVar(&stateDir, "state-dir", "", "state directory")
	flag.StringVar(&logFile, "log-file", "", "log file path")
}

func main() {
	flag.Parse()

	if tokenFile == "" || stateDir == "" {
		flag.Usage()
		log.Fatal("both --token-file and --state-dir are required")
	}

	token, err := os.ReadFile(tokenFile)
	if err != nil {
		log.Fatalf("failed to read token file: %v", err)
	}

	if logFile != "" {
		f, err := os.OpenFile(logFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if err != nil {
			log.Fatalf("failed to open log file: %v", err)
		}
		defer f.Close()
		log.SetOutput(f)
		log.SetFlags(log.LstdFlags | log.Lshortfile)
	}

	st := state.New(stateDir)
	if err := st.Init(); err != nil {
		log.Fatalf("failed to initialize state: %v", err)
	}

	mux := http.NewServeMux()
	h := handler.New(string(token), st)
	require := func(next http.HandlerFunc) http.HandlerFunc {
		return auth.Require(string(token), next)
	}

	mux.HandleFunc("/global/health", require(h.Health))
	mux.HandleFunc("/global/event", require(h.Events))
	mux.HandleFunc("/experimental/workspace/adaptor", require(h.WorkspaceAdaptor))
	mux.HandleFunc("/experimental/workspace", require(h.WorkspaceList))
	mux.HandleFunc("/experimental/workspace/status", require(h.WorkspaceStatus))

	mux.HandleFunc("/session", require(h.SessionCreate))
	mux.HandleFunc("/session/status", require(h.SessionStatus))
	mux.HandleFunc("/session/", require(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path[len("/session/"):]
		if strings.HasSuffix(path, "/shell") {
			h.Shell(w, r)
			return
		}
		if strings.HasSuffix(path, "/command") {
			h.Command(w, r)
			return
		}
		if r.Method == http.MethodGet {
			h.SessionGet(w, r)
			return
		}
		if r.Method == http.MethodDelete {
			h.SessionDelete(w, r)
			return
		}
		handler.Error(w, 405, "method_not_allowed", "GET, DELETE, /shell, or /command required")
	}))
	mux.HandleFunc("/permission", require(h.PermissionList))
	mux.HandleFunc("/permission/", require(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			h.PermissionReply(w, r)
			return
		}
		handler.Error(w, 405, "method_not_allowed", "POST required")
	}))

	handler.WithWorkspaceRoutes(mux, require, h)

	server := &http.Server{
		Addr:    listenAddr,
		Handler: mux,
	}

	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
		<-sigCh
		log.Println("shutting down")
		server.Close()
	}()

	log.Printf("stub listening on %s", listenAddr)
	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
}