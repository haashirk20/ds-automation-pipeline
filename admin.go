package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"html/template"
	"io"
	"net/http"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

type admin struct {
	flashMu   sync.Mutex
	flash     *view // result of the last POST, shown once by the next GET of its page
	s         *svc
	pwHash    [32]byte
	csrf      string
	maxUpload int64
	hosts     []string
	origins   []string
	mux       *http.ServeMux
}

var authDelay = time.Second // slows password guessing

// done stores the result of a POST and sends the browser back to a GET, so F5 cannot repeat the POST.
func (a *admin) done(w http.ResponseWriter, r *http.Request, v view) {
	a.flashMu.Lock()
	a.flash = &v
	a.flashMu.Unlock()
	path := map[string]string{"status": "/", "settings": "/settings", "captions": "/captions", "upload": "/upload"}[v.Page]
	http.Redirect(w, r, path, http.StatusSeeOther)
}

// take returns the stored POST result when it is for v's page, else v.
func (a *admin) take(v view) view {
	a.flashMu.Lock()
	defer a.flashMu.Unlock()
	if a.flash != nil && a.flash.Page == v.Page {
		v, a.flash = *a.flash, nil
	}
	return v
}

var uploadKinds = map[string]struct {
	folder string
	mimes  map[string]string
}{
	"video": {"videos", map[string]string{".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/x-m4v", ".webm": "video/webm"}},
	"music": {"music", map[string]string{".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg"}},
}

func newAdmin(s *svc, password string, maxUpload int64, port string) (*admin, error) {
	tok := make([]byte, 32)
	if _, err := rand.Read(tok); err != nil {
		return nil, err
	}
	a := &admin{s: s, pwHash: sha256.Sum256([]byte(password)), csrf: hex.EncodeToString(tok), maxUpload: maxUpload,
		hosts:   []string{"127.0.0.1:" + port, "localhost:" + port},
		origins: []string{"http://127.0.0.1:" + port, "http://localhost:" + port},
		mux:     http.NewServeMux()}
	a.mux.HandleFunc("GET /{$}", a.status)
	a.mux.HandleFunc("GET /settings", a.docPage("settings"))
	a.mux.HandleFunc("POST /settings", a.saveSettings)
	a.mux.HandleFunc("GET /captions", a.docPage("captions"))
	a.mux.HandleFunc("POST /captions", a.saveCaptions)
	a.mux.HandleFunc("POST /captions/add", a.addCaption)
	a.mux.HandleFunc("GET /upload", func(w http.ResponseWriter, r *http.Request) { a.render(w, a.take(view{Page: "upload"})) })
	a.mux.HandleFunc("POST /upload", a.upload)
	a.mux.HandleFunc("POST /post-now", a.postNow)
	return a, nil
}

func (a *admin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("X-Frame-Options", "DENY")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
	if !slices.Contains(a.hosts, r.Host) { // DNS rebinding
		http.Error(w, "bad host", http.StatusForbidden)
		return
	}
	_, pw, ok := r.BasicAuth()
	got := sha256.Sum256([]byte(pw))
	if !ok || subtle.ConstantTimeCompare(got[:], a.pwHash[:]) != 1 {
		time.Sleep(authDelay)
		w.Header().Set("WWW-Authenticate", `Basic realm="uploader"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if r.Method == http.MethodPost {
		if o := r.Header.Get("Origin"); o != "" && !slices.Contains(a.origins, o) {
			http.Error(w, "bad origin", http.StatusForbidden)
			return
		}
		// the multipart upload carries the token in the URL so it is checked before the body is read
		var tok string
		if r.URL.Path == "/upload" {
			tok = r.URL.Query().Get("csrf")
		} else {
			r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
			tok = r.PostFormValue("csrf")
		}
		if subtle.ConstantTimeCompare([]byte(tok), []byte(a.csrf)) != 1 {
			http.Error(w, "bad csrf token", http.StatusForbidden)
			return
		}
	}
	a.mux.ServeHTTP(w, r)
}

type slotRow struct{ ID, Time, State string }
type claimRow struct{ ID, At string }

type view struct {
	Page, Msg, Err, Text string
	CSRF, Nonce          string
	PerDay               int
	Slots                []slotRow
	Videos, Music, Caps  int
	LastAt, LastWhat     string
	LastErr              string
	Running              bool
	Claims               []claimRow
	MaxMB                int64
}

func (a *admin) render(w http.ResponseWriter, v view) {
	v.CSRF, v.MaxMB = a.csrf, a.maxUpload>>20
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := page.Execute(w, v); err != nil {
		a.s.t.log.Error("render", "err", err.Error())
	}
}

func (a *admin) docID(ctx context.Context, name string) (string, error) {
	ids, err := a.s.t.resolveIDs(ctx, name)
	return ids[name], err
}

func (a *admin) status(w http.ResponseWriter, r *http.Request) {
	v := a.take(view{Page: "status"})
	nb := make([]byte, 8)
	rand.Read(nb)
	v.Nonce = hex.EncodeToString(nb)
	s := a.s
	now := s.now()
	if s.tickMu.TryLock() {
		s.tickMu.Unlock()
	} else {
		v.Running = true
	}
	s.mu.Lock()
	v.LastWhat, v.LastErr = s.lastWhat, s.lastErr
	if !s.lastAt.IsZero() {
		v.LastAt = s.lastAt.UTC().Format(time.RFC3339)
	}
	s.mu.Unlock()
	if l, err := s.t.load(r.Context(), now, true); err != nil {
		v.Err = strings.TrimSpace(v.Err + " " + err.Error())
	} else {
		v.PerDay = len(l.set.Times)
		v.Slots = todaySlots(l.set, l.st, now)
		v.Claims = recentClaims(l.st, 8)
	}
	for _, c := range []struct {
		name, mime string
		n          *int
	}{{"videos", "video/", &v.Videos}, {"music", "audio/", &v.Music}} {
		if id, err := a.docID(r.Context(), c.name); err == nil {
			if fs, err := s.t.d.list(r.Context(), id, c.mime); err == nil {
				*c.n = len(fs)
			}
		}
	}
	if id, err := a.docID(r.Context(), "captions"); err == nil {
		if text, err := s.t.d.exportText(r.Context(), id); err == nil {
			v.Caps = len(parseCaptions(text))
		}
	}
	a.render(w, v)
}

func todaySlots(set Settings, st state, now time.Time) []slotRow {
	local := now.In(set.Loc)
	count := map[string]int{}
	var out []slotRow
	for _, hm := range set.Times {
		count[hm]++
		var h, m int
		fmt.Sscanf(hm, "%d:%d", &h, &m)
		at := time.Date(local.Year(), local.Month(), local.Day(), h, m, 0, 0, set.Loc)
		id := fmt.Sprintf("%s %s#%d", at.Format("2006-01-02"), hm, count[hm])
		state := "upcoming"
		if _, ok := st.Claims[id]; ok {
			state = "claimed"
		} else if set.Paused {
			state = "paused"
		} else if !at.After(now) {
			state = "due"
			if now.Sub(at) > slotWindow {
				state = "missed"
			}
		}
		out = append(out, slotRow{id, hm, state})
	}
	return out
}

func recentClaims(st state, n int) []claimRow {
	var out []claimRow
	for k, v := range st.Claims {
		out = append(out, claimRow{k, v})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At > out[j].At })
	if len(out) > n {
		out = out[:n]
	}
	return out
}

// docPage shows the text of the settings or captions doc in a textarea.
func (a *admin) docPage(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v := view{Page: name}
		id, err := a.docID(r.Context(), name)
		if err == nil {
			v.Text, err = a.s.t.d.exportText(r.Context(), id)
		}
		if err != nil {
			v.Err = err.Error()
		}
		a.render(w, a.take(v))
	}
}

func cleanText(s string) string {
	s = strings.ReplaceAll(strings.ReplaceAll(s, "\r\n", "\n"), "\r", "\n")
	return strings.TrimRight(s, " \n\t") + "\n"
}

// saveDoc writes text to a Google Doc. Drive converts text/plain media on a Doc update (see SPEC.md).
func (a *admin) saveDoc(ctx context.Context, name, text string) error {
	id, err := a.docID(ctx, name)
	if err != nil {
		return err
	}
	return a.s.t.fix(a.s.t.d.update(ctx, id, []byte(text), "text/plain"))
}

func (a *admin) saveSettings(w http.ResponseWriter, r *http.Request) {
	text := cleanText(r.PostFormValue("text"))
	v := view{Page: "settings", Text: text}
	if _, err := parseSettings(text); err != nil { // never write what the tick would refuse
		v.Err = "not saved: " + err.Error()
	} else if err := a.saveDoc(r.Context(), "settings", text); err != nil {
		v.Err = "save failed: " + err.Error()
	} else {
		v.Msg = "settings saved"
	}
	a.done(w, r, v)
}

func (a *admin) saveCaptions(w http.ResponseWriter, r *http.Request) {
	text := cleanText(r.PostFormValue("text"))
	v := view{Page: "captions", Text: text}
	if err := a.saveDoc(r.Context(), "captions", text); err != nil {
		v.Err = "save failed: " + err.Error()
	} else {
		v.Msg = "captions saved"
	}
	a.done(w, r, v)
}

func (a *admin) addCaption(w http.ResponseWriter, r *http.Request) {
	line := strings.Join(strings.Fields(r.PostFormValue("caption")), " ")
	v := view{Page: "captions"}
	id, err := a.docID(r.Context(), "captions")
	if err == nil {
		v.Text, err = a.s.t.d.exportText(r.Context(), id)
	}
	switch {
	case err != nil:
		v.Err = err.Error()
	case line == "" || strings.HasPrefix(line, "#"):
		v.Err = "caption is empty or starts with #"
	default:
		text := cleanText(v.Text) + line + "\n"
		if err := a.saveDoc(r.Context(), "captions", text); err != nil {
			v.Err = "save failed: " + err.Error()
		} else {
			v.Text, v.Msg = text, "caption added"
		}
	}
	a.done(w, r, v)
}

func (a *admin) postNow(w http.ResponseWriter, r *http.Request) {
	v := view{Page: "status"}
	nonce := r.PostFormValue("nonce")
	if len(nonce) != 16 || strings.Trim(nonce, "0123456789abcdef") != "" {
		v.Err = "bad post-now form, reload the page"
	} else if err := a.s.postNow(nonce); err != nil {
		v.Err = err.Error()
	} else {
		v.Msg = "manual post started"
	}
	a.done(w, r, v)
}

// upload streams the multipart body into a Drive resumable upload. The form must send `kind` before `file`.
func (a *admin) upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, a.maxUpload+1<<20)
	v := view{Page: "upload"}
	id, name, err := a.streamUpload(r)
	if err != nil {
		v.Err = "upload failed: " + err.Error()
	} else {
		v.Msg = fmt.Sprintf("uploaded %s (%s)", name, id)
	}
	a.done(w, r, v)
}

func (a *admin) streamUpload(r *http.Request) (id, name string, err error) {
	mr, err := r.MultipartReader()
	if err != nil {
		return "", "", err
	}
	kind := ""
	for {
		p, err := mr.NextPart()
		if err == io.EOF {
			return "", "", errors.New("no file in form")
		}
		if err != nil {
			return "", "", err
		}
		switch p.FormName() {
		case "kind":
			b, _ := io.ReadAll(io.LimitReader(p, 16))
			kind = string(b)
		case "file":
			k, ok := uploadKinds[kind]
			if !ok {
				return "", "", errors.New("kind must come before file and be video or music")
			}
			name = filepath.Base(p.FileName())
			mime, ok := k.mimes[strings.ToLower(filepath.Ext(name))]
			if !ok || strings.ContainsAny(name, "\x00\r\n") {
				return "", "", fmt.Errorf("file type not allowed for %s", kind)
			}
			parent, err := a.docID(r.Context(), k.folder)
			if err != nil {
				return "", "", err
			}
			id, err = a.s.t.d.uploadStream(r.Context(), parent, name, mime, p)
			return id, name, err
		}
	}
}

var page = template.Must(template.New("page").Parse(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>uploader</title>
<style>
body{font:15px/1.4 system-ui,sans-serif;max-width:46rem;margin:1rem auto;padding:0 1rem}
nav a{margin-right:1rem}textarea{width:100%;height:22rem;font:13px monospace}
.msg{background:#dfd;padding:.4rem}.err{background:#fdd;padding:.4rem}
table{border-collapse:collapse}td,th{padding:.15rem .6rem;text-align:left;border-bottom:1px solid #ddd}
</style></head><body>
<nav><a href="/">Status</a><a href="/settings">Settings</a><a href="/captions">Captions</a><a href="/upload">Upload</a></nav>
{{if .Msg}}<p class="msg">{{.Msg}}</p>{{end}}{{if .Err}}<p class="err">{{.Err}}</p>{{end}}
{{if eq .Page "status"}}
<h2>Status</h2>
<p>Videos per day: {{.PerDay}}. Videos: {{.Videos}}, music: {{.Music}}, captions: {{.Caps}}.</p>
<h3>Today</h3>
<table>{{range .Slots}}<tr><td>{{.Time}}</td><td>{{.State}}</td><td>{{.ID}}</td></tr>{{else}}<tr><td>none</td></tr>{{end}}</table>
<h3>Last run</h3>
<p>{{if .Running}}running now{{else if .LastAt}}{{.LastWhat}} at {{.LastAt}}: {{if .LastErr}}error: {{.LastErr}}{{else}}ok{{end}}{{else}}none yet{{end}}</p>
<h3>Recent claims</h3>
<table>{{range .Claims}}<tr><td>{{.ID}}</td><td>{{.At}}</td></tr>{{else}}<tr><td>none</td></tr>{{end}}</table>
<form method="post" action="/post-now"><input type="hidden" name="csrf" value="{{.CSRF}}"><input type="hidden" name="nonce" value="{{.Nonce}}"><p><button>Post now</button> (claims a manual slot and publishes)</p></form>
{{else if eq .Page "settings"}}
<h2>Settings</h2>
<form method="post" action="/settings"><input type="hidden" name="csrf" value="{{.CSRF}}">
<textarea name="text" spellcheck="false">{{.Text}}</textarea><p><button>Save</button> (checked before it is written)</p></form>
{{else if eq .Page "captions"}}
<h2>Captions</h2>
<form method="post" action="/captions/add"><input type="hidden" name="csrf" value="{{.CSRF}}">
<p><input name="caption" size="50" placeholder="one new caption"> <button>Add</button></p></form>
<form method="post" action="/captions"><input type="hidden" name="csrf" value="{{.CSRF}}">
<textarea name="text" spellcheck="false">{{.Text}}</textarea><p><button>Save</button></p></form>
{{else}}
<h2>Upload</h2>
<form method="post" action="/upload?csrf={{.CSRF}}" enctype="multipart/form-data">
<p><select name="kind"><option value="video">video (.mp4 .mov .m4v .webm)</option><option value="music">music (.mp3 .m4a .aac .wav .ogg)</option></select></p>
<p><input type="file" name="file" required></p><p><button>Upload</button> (max {{.MaxMB}} MB)</p></form>
{{end}}
</body></html>`))
