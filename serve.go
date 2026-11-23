package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// svc is the long-running side: one ticker, at most one run at a time, and what the admin page shows.
type svc struct {
	t      *ticker
	now    func() time.Time
	runCtx context.Context // cancelled only on a second signal or after the grace period

	tickMu   sync.Mutex // held while a tick or manual post runs
	mu       sync.Mutex // guards the fields below
	lastAt   time.Time
	lastErr  string
	lastWhat string
	running  bool

	idsMu sync.Mutex
	ids   map[string]string
}

// exec runs one tick (manual == "" ) or one manual slot. The caller holds tickMu.
func (s *svc) exec(manual string) {
	now := s.now()
	err := s.t.fix(s.t.run(s.runCtx, now, manual))
	s.mu.Lock()
	s.lastAt, s.lastWhat, s.lastErr = now, "tick", ""
	if manual != "" {
		s.lastWhat = manual
	}
	if err != nil {
		s.lastErr = err.Error()
		s.t.log.Error("run failed", "what", s.lastWhat, "err", err.Error())
	}
	s.mu.Unlock()
}

// serveLoop runs a tick on every value of ticks (and once at start) until stop is done.
func (s *svc) serveLoop(stop context.Context, ticks <-chan time.Time) {
	for {
		if stop.Err() == nil && s.tickMu.TryLock() {
			s.exec("")
			s.tickMu.Unlock()
		}
		select {
		case <-stop.Done():
			return
		case <-ticks:
		}
	}
}

// postNow starts one extra slot in the background; it fails when a run is already going.
func (s *svc) postNow(nonce string) error {
	if !s.tickMu.TryLock() {
		return errors.New("a run is already in progress")
	}
	go func() {
		defer s.tickMu.Unlock()
		s.exec("manual " + nonce)
	}()
	return nil
}

// checkAdminAddr accepts only a loopback IP or "localhost" as host and returns the port.
func checkAdminAddr(addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("ADMIN_ADDR %q: %w", addr, err)
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return fmt.Errorf("ADMIN_ADDR host %q is not a loopback address", host)
	}
	if n, err := strconv.Atoi(port); err != nil || n < 0 || n > 65535 {
		return fmt.Errorf("ADMIN_ADDR bad port %q", port)
	}
	return nil
}

// lockFile takes an exclusive non-blocking flock so only one serve/tick process runs. Keep the file open.
func lockFile(path string) (*os.File, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, fmt.Errorf("another uploader process is already running (lock %s)", path)
		}
		return nil, err
	}
	return f, nil
}

func serveCmd(ctx, stop context.Context, t *ticker, clock func() time.Time, getenv func(string) string) error {
	addr := getenv("ADMIN_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8080"
	}
	if err := checkAdminAddr(addr); err != nil {
		return err
	}
	pw := getenv("ADMIN_PASSWORD")
	if len(pw) < 12 {
		return errors.New("ADMIN_PASSWORD must be at least 12 characters")
	}
	maxMB := int64(500)
	if v := getenv("ADMIN_MAX_UPLOAD_MB"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 1 {
			return errors.New("ADMIN_MAX_UPLOAD_MB must be a positive integer")
		}
		maxMB = n
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	s := &svc{t: t, now: clock, runCtx: ctx}
	a, err := newAdmin(s, pw, maxMB<<20, port)
	if err != nil {
		return err
	}
	srv := &http.Server{Handler: a, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
	go srv.Serve(ln)
	slog.Info("serving", "admin", ln.Addr().String())

	tk := time.NewTicker(time.Minute)
	defer tk.Stop()
	s.serveLoop(stop, tk.C)

	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	srv.Shutdown(sctx)
	s.tickMu.Lock() // wait for an in-flight run (ctx is cancelled by the second signal or the grace timer)
	return nil
}

// serveSignals returns (runCtx, stopCtx). The first SIGINT/SIGTERM cancels stopCtx so nothing new starts;
// runCtx is cancelled by a second signal or after grace.
func serveSignals(grace time.Duration) (context.Context, context.Context) {
	runCtx, cancelRun := context.WithCancel(context.Background())
	stopCtx, cancelStop := context.WithCancel(context.Background())
	sigs := make(chan os.Signal, 2)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigs
		slog.Info("signal received, finishing current run")
		cancelStop()
		select {
		case <-sigs:
		case <-time.After(grace):
		}
		cancelRun()
	}()
	return runCtx, stopCtx
}
