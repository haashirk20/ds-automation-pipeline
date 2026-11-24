package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

type fkFile struct {
	id, name, mime, parent, content string
}

type fkDrive struct {
	mu         sync.Mutex
	files      []*fkFile
	pageSize   int // 0 = everything on one page
	failUpdate bool
	onUpdate   func(id, body string)
	nextID     int
	ranges     []string // Content-Range of each resumable chunk
	upParent   string
	mediaGets  map[string]int // GET alt=media count per file ID
	denyParent string         // resumable uploads into this folder ID answer 403
	shortRange bool           // answer 308 with a Range that is too short
	srv        *httptest.Server
}

var (
	reParent = regexp.MustCompile(`'((?:[^'\\]|\\.)*)' in parents`)
	reName   = regexp.MustCompile(`name='((?:[^'\\]|\\.)*)'`)
	reMime   = regexp.MustCompile(`mimeType (contains|=) '([^']*)'`)
)

func unq(s string) string { return strings.NewReplacer("\\'", "'", "\\\\", "\\").Replace(s) }

func newFkDrive(t *testing.T) *fkDrive {
	f := &fkDrive{}
	f.srv = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fkDrive) drive() *drive {
	d := newDrive(f.srv.Client(), func(context.Context) (string, error) { return "tok", nil })
	d.api, d.upload = f.srv.URL+"/drive/v3", f.srv.URL+"/upload/drive/v3"
	return d
}

func (f *fkDrive) add(id, name, mime, parent, content string) {
	f.files = append(f.files, &fkFile{id, name, mime, parent, content})
}

func (f *fkDrive) byName(name string) *fkFile {
	for _, x := range f.files {
		if x.name == name {
			return x
		}
	}
	return nil
}

func (f *fkDrive) get(id string) *fkFile {
	for _, x := range f.files {
		if x.id == id {
			return x
		}
	}
	return nil
}

func (f *fkDrive) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer tok" {
		http.Error(w, `{"error":{"message":"unauthorized"}}`, 401)
		return
	}
	p := strings.TrimPrefix(r.URL.Path, "/drive/v3")
	switch {
	case r.Method == "GET" && p == "/files":
		q := r.URL.Query().Get("q")
		var out []map[string]string
		for _, x := range f.files {
			if m := reParent.FindStringSubmatch(q); m == nil || unq(m[1]) != x.parent {
				continue
			}
			if m := reName.FindStringSubmatch(q); m != nil && unq(m[1]) != x.name {
				continue
			}
			if m := reMime.FindStringSubmatch(q); m != nil && !(m[1] == "=" && x.mime == m[2] || m[1] == "contains" && strings.Contains(x.mime, m[2])) {
				continue
			}
			out = append(out, map[string]string{"id": x.id, "name": x.name, "mimeType": x.mime})
		}
		start, next := 0, ""
		if tok := r.URL.Query().Get("pageToken"); tok != "" {
			start, _ = strconv.Atoi(tok)
		}
		if f.pageSize > 0 && start+f.pageSize < len(out) {
			next = strconv.Itoa(start + f.pageSize)
			out = out[start : start+f.pageSize]
		} else {
			out = out[start:]
		}
		json.NewEncoder(w).Encode(map[string]any{"files": out, "nextPageToken": next})
	case r.Method == "GET" && strings.HasSuffix(p, "/export"):
		x := f.get(strings.TrimSuffix(strings.TrimPrefix(p, "/files/"), "/export"))
		if x == nil || r.URL.Query().Get("mimeType") != "text/plain" {
			http.Error(w, `{"error":{"message":"not found"}}`, 404)
			return
		}
		io.WriteString(w, x.content)
	case r.Method == "GET" && strings.HasPrefix(p, "/files/"):
		x := f.get(strings.TrimPrefix(p, "/files/"))
		if x == nil || r.URL.Query().Get("alt") != "media" {
			http.Error(w, `{"error":{"message":"not found"}}`, 404)
			return
		}
		if f.mediaGets == nil {
			f.mediaGets = map[string]int{}
		}
		f.mediaGets[x.id]++
		io.WriteString(w, x.content)
	case r.Method == "PATCH" && strings.HasPrefix(r.URL.Path, "/upload/drive/v3/files/"):
		if f.failUpdate {
			http.Error(w, `{"error":{"message":"quota"}}`, 403)
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/upload/drive/v3/files/")
		x := f.get(id)
		b, _ := io.ReadAll(r.Body)
		if x == nil {
			http.Error(w, `{"error":{"message":"not found"}}`, 404)
			return
		}
		x.content = string(b)
		if f.onUpdate != nil {
			f.onUpdate(id, x.content)
		}
		io.WriteString(w, "{}")
	case r.Method == "POST" && p == "/files": // folder
		var meta struct {
			Name, MimeType string
			Parents        []string
		}
		json.NewDecoder(r.Body).Decode(&meta)
		f.nextID++
		id := fmt.Sprintf("new%d", f.nextID)
		f.add(id, meta.Name, meta.MimeType, meta.Parents[0], "")
		fmt.Fprintf(w, `{"id":%q}`, id)
	case r.Method == "POST" && r.URL.Query().Get("uploadType") == "resumable":
		var meta struct {
			Name, MimeType string
			Parents        []string
		}
		json.NewDecoder(r.Body).Decode(&meta)
		if f.denyParent != "" && meta.Parents[0] == f.denyParent {
			http.Error(w, `{"error":{"message":"forbidden"}}`, 403)
			return
		}
		f.nextID++
		id := fmt.Sprintf("new%d", f.nextID)
		f.add(id, meta.Name, meta.MimeType, meta.Parents[0], "")
		f.upParent = id
		w.Header().Set("Location", f.srv.URL+"/session/"+id)
	case r.Method == "PUT" && strings.HasPrefix(r.URL.Path, "/session/"):
		x := f.get(strings.TrimPrefix(r.URL.Path, "/session/"))
		b, _ := io.ReadAll(r.Body)
		x.content += string(b)
		cr := r.Header.Get("Content-Range")
		f.ranges = append(f.ranges, cr)
		if strings.HasSuffix(cr, "/*") {
			end := len(x.content) - 1
			if f.shortRange {
				end--
			}
			w.Header().Set("Range", fmt.Sprintf("bytes=0-%d", end))
			w.WriteHeader(308)
			return
		}
		fmt.Fprintf(w, `{"id":%q}`, x.id)
	case r.Method == "POST" && r.URL.Path == "/upload/drive/v3/files":
		_, params, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		mr := multipart.NewReader(r.Body, params["boundary"])
		pt, _ := mr.NextPart()
		mb, _ := io.ReadAll(pt)
		var meta struct {
			Name, MimeType string
			Parents        []string
		}
		json.Unmarshal(mb, &meta)
		pt, _ = mr.NextPart()
		cb, _ := io.ReadAll(pt)
		f.nextID++
		id := fmt.Sprintf("new%d", f.nextID)
		f.add(id, meta.Name, meta.MimeType, meta.Parents[0], string(cb))
		fmt.Fprintf(w, `{"id":%q}`, id)
	default:
		http.Error(w, `{"error":{"message":"unexpected `+r.Method+" "+r.URL.Path+`"}}`, 400)
	}
}

func TestDriveListPagingAndEscape(t *testing.T) {
	f := newFkDrive(t)
	f.pageSize = 2
	for i := 0; i < 5; i++ {
		f.add(fmt.Sprint("v", i), fmt.Sprint("v", i, ".mp4"), "video/mp4", "root", "x")
	}
	f.add("a", "a.mp3", "audio/mpeg", "root", "x")
	f.add("o", "other.mp4", "video/mp4", "elsewhere", "x")
	got, err := f.drive().list(context.Background(), "root", "video/")
	if err != nil || len(got) != 5 {
		t.Fatalf("got %d err %v", len(got), err)
	}
	f.add("q", `it's.txt`, "text/plain", "root", "x")
	one, err := f.drive().find(context.Background(), "root", `it's.txt`)
	if err != nil || len(one) != 1 {
		t.Fatalf("find: %v %v", one, err)
	}
}

func TestDriveExportAndDownload(t *testing.T) {
	f := newFkDrive(t)
	f.add("doc", "settings", docMime, "root", "\xef\xbb\xbfa = 1\r\nb = 2\r\n")
	f.add("vid", "v.mp4", "video/mp4", "root", "VIDEODATA")
	d := f.drive()
	txt, err := d.exportText(context.Background(), "doc")
	if err != nil || txt != "a = 1\nb = 2\n" {
		t.Fatalf("%q %v", txt, err)
	}
	dest := filepath.Join(t.TempDir(), "v")
	if err := d.download(context.Background(), "vid", dest); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(dest); string(b) != "VIDEODATA" {
		t.Fatalf("%q", b)
	}
	if _, err := d.exportText(context.Background(), "missing"); err == nil || !strings.Contains(err.Error(), "404") || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("want 404 with API message, got %v", err)
	}
}

func TestDriveResolve(t *testing.T) {
	f := newFkDrive(t)
	f.add("1", "settings", docMime, "root", "")
	f.add("2", "state.json", "application/json", "root", "")
	f.add("3", "dup", docMime, "root", "")
	f.add("4", "dup", docMime, "root", "")
	d := f.drive()
	ids, err := d.resolve(context.Background(), "root", "settings", "state.json")
	if err != nil || ids["settings"] != "1" || ids["state.json"] != "2" {
		t.Fatalf("%v %v", ids, err)
	}
	if _, err := d.resolve(context.Background(), "root", "missing"); err == nil {
		t.Error("missing must fail")
	}
	if _, err := d.resolve(context.Background(), "root", "dup"); err == nil {
		t.Error("duplicate must fail")
	}
}

func TestInitLayoutIdempotent(t *testing.T) {
	f := newFkDrive(t)
	d := f.drive()
	var out bytes.Buffer
	if err := initLayout(context.Background(), d, "root", &out); err != nil {
		t.Fatal(err)
	}
	if len(f.files) != 6 || strings.Count(out.String(), "created") != 6 {
		t.Fatalf("files %d out %s", len(f.files), out.String())
	}
	settings := f.get(strings.Fields(strings.Split(out.String(), "\n")[2])[1])
	if settings.mime != docMime || !strings.Contains(settings.content, "times = ") {
		t.Fatalf("settings doc %+v", settings)
	}
	if p := f.byName("products"); p == nil || p.mime != docMime || !strings.Contains(p.content, "[Velvet Tarot Deck]") {
		t.Fatalf("products doc %+v", p)
	}
	out.Reset()
	if err := initLayout(context.Background(), d, "root", &out); err != nil {
		t.Fatal(err)
	}
	if len(f.files) != 6 || strings.Count(out.String(), "exists") != 6 {
		t.Fatalf("second run created more: %d\n%s", len(f.files), out.String())
	}
	f.add("dupe", "music", folderMime, "root", "")
	if err := initLayout(context.Background(), d, "root", &out); err == nil {
		t.Fatal("duplicates must refuse")
	}
}

func TestGoogleTokenCached(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		r.ParseForm()
		if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "rt" ||
			r.Form.Get("client_id") != "cid" || r.Form.Get("client_secret") != "cs" {
			http.Error(w, `{"error":"invalid_grant","error_description":"bad"}`, 400)
			return
		}
		fmt.Fprint(w, `{"access_token":"at","expires_in":3600}`)
	}))
	defer srv.Close()
	clock := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	g := &googleAuth{clientID: "cid", clientSecret: "cs", refreshToken: "rt", hc: srv.Client(), tokenURL: srv.URL,
		now: func() time.Time { return clock }}
	for i := 0; i < 2; i++ {
		if tok, err := g.Token(context.Background()); err != nil || tok != "at" {
			t.Fatalf("%q %v", tok, err)
		}
	}
	if hits != 1 {
		t.Fatalf("hits %d, want 1", hits)
	}
	clock = clock.Add(3541 * time.Second) // within 60 s of expiry
	g.Token(context.Background())
	if hits != 2 {
		t.Fatalf("hits %d, want refresh", hits)
	}
	g.refreshToken = "wrong"
	clock = clock.Add(2 * time.Hour)
	_, err := g.Token(context.Background())
	if err == nil || !strings.Contains(err.Error(), "invalid_grant") || strings.Contains(err.Error(), "wrong") {
		t.Fatalf("err %v", err)
	}
}

func TestApiErrorHidesQuery(t *testing.T) {
	err := apiError("GET", "https://x.test/a/b?access_token=SECRET&q=1", 403, []byte(`{"error":{"message":"nope"}}`))
	if s := err.Error(); strings.Contains(s, "SECRET") || !strings.Contains(s, "x.test/a/b") || !strings.Contains(s, "403") || !strings.Contains(s, "nope") {
		t.Fatal(s)
	}
}
