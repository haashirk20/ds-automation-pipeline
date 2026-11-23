package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

const testPW = "correct horse battery"

func newAdminEnv(t *testing.T) (*tickEnv, *admin) {
	authDelay = 0
	e := newTickEnv(t, settingsOne, probeLong)
	s := &svc{t: e.tk, now: func() time.Time { return e.now }, runCtx: context.Background()}
	a, err := newAdmin(s, testPW, 1<<20, "8080")
	if err != nil {
		t.Fatal(err)
	}
	return e, a
}

func (a *admin) do(method, path, host, pw string, hdr map[string]string, body io.Reader) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, body)
	r.Host = host
	if pw != "" {
		r.SetBasicAuth("me", pw)
	}
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	return w
}

func (a *admin) rawPost(path string, form url.Values) *httptest.ResponseRecorder {
	return a.do("POST", path, "127.0.0.1:8080", testPW,
		map[string]string{"Content-Type": "application/x-www-form-urlencoded"}, strings.NewReader(form.Encode()))
}

// follow turns a 303 into the GET it points to, as a browser does.
func (a *admin) follow(w *httptest.ResponseRecorder) *httptest.ResponseRecorder {
	if w.Code != 303 {
		return w
	}
	return a.do("GET", w.Header().Get("Location"), "127.0.0.1:8080", testPW, nil, nil)
}

func (a *admin) post(path string, form url.Values) *httptest.ResponseRecorder {
	return a.follow(a.rawPost(path, form))
}

func TestAdminHostAndAuth(t *testing.T) {
	_, a := newAdminEnv(t)
	if w := a.do("GET", "/", "evil.example:8080", testPW, nil, nil); w.Code != 403 {
		t.Fatalf("bad host: %d", w.Code)
	}
	if w := a.do("GET", "/", "127.0.0.1:9999", testPW, nil, nil); w.Code != 403 {
		t.Fatalf("bad port: %d", w.Code)
	}
	if w := a.do("GET", "/", "127.0.0.1:8080", "", nil, nil); w.Code != 401 {
		t.Fatalf("no password: %d", w.Code)
	}
	if w := a.do("GET", "/", "localhost:8080", "wrong password!", nil, nil); w.Code != 401 {
		t.Fatalf("wrong password: %d", w.Code)
	}
	w := a.do("GET", "/", "localhost:8080", testPW, nil, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Videos per day: 1") || !strings.Contains(w.Body.String(), "2026-11-12 09:00#1") {
		t.Fatalf("status: %d %s", w.Code, w.Body.String())
	}
}

func TestAdminPostNeedsCSRFAndOrigin(t *testing.T) {
	e, a := newAdminEnv(t)
	form := url.Values{"text": {settingsOne}}
	if w := a.rawPost("/settings", form); w.Code != 403 {
		t.Fatalf("no csrf: %d", w.Code)
	}
	form.Set("csrf", "nope")
	if w := a.rawPost("/settings", form); w.Code != 403 {
		t.Fatalf("bad csrf: %d", w.Code)
	}
	form.Set("csrf", a.csrf)
	w := a.do("POST", "/settings", "127.0.0.1:8080", testPW, map[string]string{
		"Content-Type": "application/x-www-form-urlencoded", "Origin": "http://evil.example"}, strings.NewReader(form.Encode()))
	if w.Code != 403 {
		t.Fatalf("bad origin: %d", w.Code)
	}
	if e.f.get("set").content != settingsOne {
		t.Fatal("settings changed")
	}
}

func TestAdminSettingsValidatedBeforeWrite(t *testing.T) {
	e, a := newAdminEnv(t)
	writes := 0
	e.f.onUpdate = func(id, body string) { writes++ }
	w := a.post("/settings", url.Values{"csrf": {a.csrf}, "text": {"times = 25:00\ntimezone = UTC\n"}})
	if w.Code != 200 || !strings.Contains(w.Body.String(), "not saved") || !strings.Contains(w.Body.String(), "bad time") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	if writes != 0 || e.f.get("set").content != settingsOne {
		t.Fatal("invalid settings were written")
	}
	good := "times = 10:00, 12:00\r\ntimezone = UTC\r\n"
	w = a.post("/settings", url.Values{"csrf": {a.csrf}, "text": {good}})
	if !strings.Contains(w.Body.String(), "settings saved") || writes != 1 {
		t.Fatalf("%s", w.Body.String())
	}
	if got := e.f.get("set").content; got != "times = 10:00, 12:00\ntimezone = UTC\n" {
		t.Fatalf("doc %q", got)
	}
}

func TestAdminPostPathsAreSizeCapped(t *testing.T) {
	_, a := newAdminEnv(t)
	big := url.Values{"csrf": {a.csrf}, "text": {strings.Repeat("a", 2<<20)}}
	if w := a.rawPost("/captions", big); w.Code != 403 {
		t.Fatalf("oversize body accepted: %d", w.Code)
	}
}

func TestAdminAddCaption(t *testing.T) {
	e, a := newAdminEnv(t)
	a.post("/captions/add", url.Values{"csrf": {a.csrf}, "caption": {"  fresh   one "}})
	if got := e.f.get("cap").content; got != "# c\nonly caption\nfresh one\n" {
		t.Fatalf("%q", got)
	}
	w := a.post("/captions/add", url.Values{"csrf": {a.csrf}, "caption": {"# no"}})
	if !strings.Contains(w.Body.String(), "starts with #") {
		t.Fatal("comment caption accepted")
	}
}

func uploadReq(a *admin, csrf, kind, fname string, data []byte) *httptest.ResponseRecorder {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	mw.WriteField("kind", kind)
	fw, _ := mw.CreateFormFile("file", fname)
	fw.Write(data)
	mw.Close()
	return a.follow(a.do("POST", "/upload?csrf="+csrf, "127.0.0.1:8080", testPW,
		map[string]string{"Content-Type": mw.FormDataContentType()}, &buf))
}

func TestAdminUploadStreamsInChunks(t *testing.T) {
	e, a := newAdminEnv(t)
	old := uploadChunk
	uploadChunk = 256 << 10
	t.Cleanup(func() { uploadChunk = old })
	data := bytes.Repeat([]byte("x"), 600<<10)

	if w := uploadReq(a, "bad", "video", "a.mp4", data); w.Code != 403 {
		t.Fatalf("csrf: %d", w.Code)
	}
	if w := uploadReq(a, a.csrf, "video", "a.exe", data); !strings.Contains(w.Body.String(), "not allowed") {
		t.Fatal("bad extension accepted")
	}
	if w := uploadReq(a, a.csrf, "music", "a.mp4", data); !strings.Contains(w.Body.String(), "not allowed") {
		t.Fatal("video in music accepted")
	}
	w := uploadReq(a, a.csrf, "video", "../dir/clip.MOV", data)
	if !strings.Contains(w.Body.String(), "uploaded clip.MOV") {
		t.Fatalf("%s", w.Body.String())
	}
	want := []string{"bytes 0-262143/*", "bytes 262144-524287/*", "bytes 524288-614399/614400"}
	if strings.Join(e.f.ranges, ",") != strings.Join(want, ",") {
		t.Fatalf("ranges %v", e.f.ranges)
	}
	var up *fkFile
	for _, f := range e.f.files {
		if f.name == "clip.MOV" {
			up = f
		}
	}
	if up == nil || up.parent != "vf" || up.mime != "video/quicktime" || len(up.content) != len(data) {
		t.Fatalf("%+v", up)
	}
	// over the cap
	if w := uploadReq(a, a.csrf, "video", "big.mp4", bytes.Repeat([]byte("y"), 2<<20)); !strings.Contains(w.Body.String(), "upload failed") {
		t.Fatal("cap not enforced")
	}
}

func TestUploadExactChunkMultiple(t *testing.T) {
	e := newTickEnv(t, settingsOne, probeLong)
	old := uploadChunk
	uploadChunk = 256 << 10
	t.Cleanup(func() { uploadChunk = old })
	if _, err := e.tk.d.uploadStream(context.Background(), "mf", "b.mp3", "audio/mpeg", bytes.NewReader(make([]byte, 512<<10))); err != nil {
		t.Fatal(err)
	}
	if strings.Join(e.f.ranges, ",") != "bytes 0-262143/*,bytes 262144-524287/524288" {
		t.Fatalf("%v", e.f.ranges)
	}
}

func TestAdminAddrMustBeLoopback(t *testing.T) {
	for _, bad := range []string{"0.0.0.0:8080", ":8080", "10.0.0.5:8080", "example.com:80", "nohost"} {
		if err := checkAdminAddr(bad); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	for _, ok := range []string{"127.0.0.1:8080", "localhost:9", "[::1]:8080"} {
		if err := checkAdminAddr(ok); err != nil {
			t.Errorf("%q: %v", ok, err)
		}
	}
	e := newTickEnv(t, settingsOne, probeLong)
	env := map[string]string{"ADMIN_ADDR": "0.0.0.0:8080", "ADMIN_PASSWORD": testPW}
	err := serveCmd(context.Background(), context.Background(), e.tk, time.Now, func(k string) string { return env[k] })
	if err == nil || !strings.Contains(err.Error(), "loopback") {
		t.Fatalf("%v", err)
	}
	env["ADMIN_ADDR"], env["ADMIN_PASSWORD"] = "127.0.0.1:0", "short"
	if err := serveCmd(context.Background(), context.Background(), e.tk, time.Now, func(k string) string { return env[k] }); err == nil {
		t.Fatal("short password accepted")
	}
}

func TestPostNowOnceEvenOnReplay(t *testing.T) {
	e, a := newAdminEnv(t)
	e.now = time.Date(2026, 11, 12, 15, 0, 0, 0, time.UTC) // nothing due
	form := url.Values{"csrf": {a.csrf}, "nonce": {"0123456789abcdef"}}
	if w := a.rawPost("/post-now", url.Values{"csrf": {a.csrf}, "nonce": {"../x"}}); w.Code != 303 || len(e.pubs["youtube"].calls) != 0 {
		t.Fatalf("bad nonce: %d", w.Code)
	}
	if w := a.rawPost("/post-now", form); w.Code != 303 {
		t.Fatalf("want 303, got %d", w.Code)
	}
	a.s.tickMu.Lock() // waits for the background run
	a.s.tickMu.Unlock()
	if body := a.do("GET", "/", "127.0.0.1:8080", testPW, nil, nil).Body.String(); !strings.Contains(body, "manual post started") {
		t.Fatalf("no result shown: %s", body)
	}
	a.rawPost("/post-now", form) // F5
	a.s.tickMu.Lock()
	a.s.tickMu.Unlock()
	var st state
	json.Unmarshal([]byte(e.f.get("st").content), &st)
	if _, ok := st.Claims["manual 0123456789abcdef"]; !ok || len(e.pubs["youtube"].calls) != 1 {
		t.Fatalf("claims %v calls %d", st.Claims, len(e.pubs["youtube"].calls))
	}
	if !strings.Contains(a.s.lastErr, "already claimed") {
		t.Fatalf("replay not refused: %q", a.s.lastErr)
	}
}

func TestLockFileExcludesSecondProcess(t *testing.T) {
	p := t.TempDir() + "/lock"
	f, err := lockFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lockFile(p); err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("%v", err)
	}
	f.Close()
	g, err := lockFile(p)
	if err != nil {
		t.Fatal(err)
	}
	g.Close()
}

func TestPreClaimFailureWaitsTwentyMinutes(t *testing.T) {
	e := newTickEnv(t, settingsOne, probeLong)
	ctx := context.Background()
	e.f.get("v1").parent = "nowhere" // no video: prepare fails before the claim
	if err := e.tk.tick(ctx, e.now); err == nil {
		t.Fatal("want failure")
	}
	e.f.get("v1").parent = "vf"
	if err := e.tk.tick(ctx, e.now.Add(5*time.Minute)); err != nil || len(e.pubs["youtube"].calls) != 0 {
		t.Fatalf("retried too soon: %v", err)
	}
	if err := e.tk.tick(ctx, e.now.Add(21*time.Minute)); err != nil || len(e.pubs["youtube"].calls) != 1 {
		t.Fatalf("not retried: %v", err)
	}
}

func TestStateNotReadWhenNothingInWindow(t *testing.T) {
	e := newTickEnv(t, settingsOne, probeLong)
	e.now = time.Date(2026, 11, 12, 15, 0, 0, 0, time.UTC)
	if err := e.tk.tick(context.Background(), e.now); err != nil || e.f.mediaGets["st"] != 0 {
		t.Fatalf("err %v, state reads %d", err, e.f.mediaGets["st"])
	}
}

func TestStaleCachedIDIsReResolved(t *testing.T) {
	e := newTickEnv(t, settingsOne, probeLong)
	ctx := context.Background()
	if _, err := e.tk.isDue(ctx, e.now); err != nil {
		t.Fatal(err)
	}
	e.f.get("set").id = "set2" // doc was replaced; the cached ID now answers 404
	if due, err := e.tk.isDue(ctx, e.now); err != nil || !due {
		t.Fatalf("due=%v err=%v", due, err)
	}
}

func TestUploadRejectsShortRange(t *testing.T) {
	e := newTickEnv(t, settingsOne, probeLong)
	e.f.shortRange = true
	old := uploadChunk
	uploadChunk = 256 << 10
	t.Cleanup(func() { uploadChunk = old })
	_, err := e.tk.d.uploadStream(context.Background(), "mf", "b.mp3", "audio/mpeg", bytes.NewReader(make([]byte, 512<<10)))
	if err == nil || !strings.Contains(err.Error(), "expected") {
		t.Fatalf("%v", err)
	}
}

func TestServeLoopRunsDueSlotOnce(t *testing.T) {
	e := newTickEnv(t, settingsOne, probeLong) // e.now = 09:30, slot 09:00 due
	s := &svc{t: e.tk, now: func() time.Time { return e.now }, runCtx: context.Background()}
	stop, cancel := context.WithCancel(context.Background())
	ticks := make(chan time.Time)
	done := make(chan struct{})
	go func() { s.serveLoop(stop, ticks); close(done) }()
	ticks <- time.Time{} // returns only once the first run (at start) has finished
	ticks <- time.Time{} // and the second
	cancel()
	<-done
	if n := len(e.pubs["youtube"].calls); n != 1 {
		t.Fatalf("youtube posts %d", n)
	}
	if s.lastErr != "" || s.lastAt.IsZero() {
		t.Fatalf("last %q %v", s.lastErr, s.lastAt)
	}
}
