package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const secret = "SEKRET-TOKEN-123"

func testPost(t *testing.T) Post {
	f := filepath.Join(t.TempDir(), "v.mp4")
	if err := os.WriteFile(f, []byte("0123456789"), 0o600); err != nil {
		t.Fatal(err)
	}
	return Post{File: f, Text: "hello #x", Title: "hello", SlotID: "2026-11-22 09:00#1", Privacy: "public"}
}

func noSecret(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("want error")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("token leaked in error: %v", err)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func TestFacebook(t *testing.T) {
	var uploaded, starts, finishes atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/"+graphVersion+"/PAGE/video_reels", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.Header.Get("Authorization") != "Bearer "+secret || strings.Contains(r.URL.RawQuery, secret) {
			t.Error("graph auth must be a header")
		}
		if r.PostForm.Get("upload_phase") == "start" {
			starts.Add(1)
			writeJSON(w, 200, map[string]string{"video_id": "V1"})
			return
		}
		finishes.Add(1)
		if r.PostForm.Get("video_state") != "PUBLISHED" || r.PostForm.Get("description") != "hello #x" {
			t.Errorf("bad finish form %v", r.PostForm)
		}
		writeJSON(w, 200, map[string]bool{"success": true})
	})
	mux.HandleFunc("/video-upload/"+graphVersion+"/V1", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		if r.Header.Get("Authorization") != "OAuth "+secret || r.Header.Get("file_size") != "10" || r.Header.Get("offset") != "0" || len(b) != 10 || r.ContentLength != 10 {
			t.Errorf("bad rupload request: %v len=%d", r.Header, len(b))
		}
		uploaded.Add(1)
		writeJSON(w, 200, map[string]bool{"success": true})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	fb := newFacebook("PAGE", secret, srv.Client()).(*facebook)
	fb.graph, fb.rupload = srv.URL+"/"+graphVersion, srv.URL
	id, err := fb.Publish(context.Background(), testPost(t))
	if err != nil || id != "V1" || uploaded.Load() != 1 || finishes.Load() != 1 {
		t.Fatalf("id=%q err=%v", id, err)
	}
}

func TestFacebookErrorNoRetryNoLeak(t *testing.T) {
	var finishes atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		switch {
		case r.PostForm.Get("upload_phase") == "start":
			writeJSON(w, 200, map[string]string{"video_id": "V1"})
		case strings.Contains(r.URL.Path, "video-upload"):
			w.WriteHeader(200)
		default:
			finishes.Add(1)
			writeJSON(w, 500, map[string]any{"error": map[string]string{"message": "boom"}})
		}
	}))
	defer srv.Close()
	fb := newFacebook("PAGE", secret, srv.Client()).(*facebook)
	fb.graph, fb.rupload = srv.URL+"/"+graphVersion, srv.URL
	_, err := fb.Publish(context.Background(), testPost(t))
	noSecret(t, err)
	if !strings.Contains(err.Error(), "500") {
		t.Fatalf("want 500 error, got %v", err)
	}
	if finishes.Load() != 1 {
		t.Fatalf("finish sent %d times, want 1", finishes.Load())
	}
}

func TestFacebookNoRedirect(t *testing.T) {
	var hits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer target.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer srv.Close()
	fb := newFacebook("PAGE", secret, srv.Client()).(*facebook)
	fb.graph, fb.rupload = srv.URL, srv.URL
	_, err := fb.Publish(context.Background(), testPost(t))
	noSecret(t, err)
	if hits.Load() != 0 {
		t.Fatal("redirect was followed")
	}
}

func igServer(t *testing.T, status string, publishes *atomic.Int32) *httptest.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/"+graphVersion+"/IG/media", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.PostForm.Get("media_type") != "REELS" || r.PostForm.Get("upload_type") != "resumable" {
			t.Errorf("bad form %v", r.PostForm)
		}
		writeJSON(w, 200, map[string]string{"id": "C1"})
	})
	mux.HandleFunc("/ig-api-upload/"+graphVersion+"/C1", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "OAuth "+secret || r.Header.Get("file_size") != "10" {
			t.Errorf("bad upload headers %v", r.Header)
		}
		writeJSON(w, 200, map[string]bool{"success": true})
	})
	var polls atomic.Int32
	mux.HandleFunc("/"+graphVersion+"/C1", func(w http.ResponseWriter, r *http.Request) {
		s := status
		if status == "FLAKY" {
			if polls.Add(1) < 2 {
				writeJSON(w, 500, map[string]any{"error": map[string]string{"message": "transient"}})
				return
			}
			s = "FINISHED"
		}
		if status == "FINISHED" && polls.Add(1) < 2 {
			s = "IN_PROGRESS"
		}
		writeJSON(w, 200, map[string]string{"status_code": s})
	})
	mux.HandleFunc("/"+graphVersion+"/IG/media_publish", func(w http.ResponseWriter, r *http.Request) {
		publishes.Add(1)
		_ = r.ParseForm()
		if r.PostForm.Get("creation_id") != "C1" {
			t.Errorf("bad creation_id")
		}
		writeJSON(w, 200, map[string]string{"id": "M1"})
	})
	return httptest.NewServer(mux)
}

func newIG(srv *httptest.Server) *instagram {
	ig := newInstagram("IG", secret, srv.Client()).(*instagram)
	ig.graph, ig.rupload = srv.URL+"/"+graphVersion, srv.URL
	ig.pollEvery, ig.pollFor = time.Millisecond, time.Second
	return ig
}

func TestInstagramSuccess(t *testing.T) {
	var pub atomic.Int32
	srv := igServer(t, "FINISHED", &pub)
	defer srv.Close()
	id, err := newIG(srv).Publish(context.Background(), testPost(t))
	if err != nil || id != "M1" || pub.Load() != 1 {
		t.Fatalf("id=%q err=%v pub=%d", id, err, pub.Load())
	}
}

func TestInstagramContainerError(t *testing.T) {
	var pub atomic.Int32
	srv := igServer(t, "ERROR", &pub)
	defer srv.Close()
	_, err := newIG(srv).Publish(context.Background(), testPost(t))
	noSecret(t, err)
	if !strings.Contains(err.Error(), "ERROR") || pub.Load() != 0 {
		t.Fatalf("err=%v pub=%d", err, pub.Load())
	}
}

func TestInstagramPublishFailureNotRetried(t *testing.T) {
	var pub atomic.Int32
	inner := igServer(t, "FINISHED", &pub)
	defer inner.Close()
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/media_publish") {
			attempts.Add(1)
			writeJSON(w, 503, map[string]any{"error": map[string]string{"message": "later"}})
			return
		}
		inner.Config.Handler.ServeHTTP(w, r)
	}))
	defer srv.Close()
	_, err := newIG(srv).Publish(context.Background(), testPost(t))
	noSecret(t, err)
	if !strings.Contains(err.Error(), "503") || attempts.Load() != 1 {
		t.Fatalf("err=%v attempts=%d", err, attempts.Load())
	}
}

// Recorded by zServer; tests in this file do not run in parallel.
var (
	gotPosts                     = map[string]map[string]any{}
	gotKeys                      = map[string]string{}
	presigns, puts, accountLists atomic.Int32
)

func zServer(t *testing.T, postStatus int, posts *atomic.Int32, polls *atomic.Int32) (*httptest.Server, *string) {
	var putAuth string
	var srv *httptest.Server
	presigns.Store(0)
	puts.Store(0)
	accountLists.Store(0)
	mux := http.NewServeMux()
	chk := func(r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+secret {
			t.Errorf("zernio %s missing auth", r.URL.Path)
		}
	}
	mux.HandleFunc("/accounts", func(w http.ResponseWriter, r *http.Request) {
		chk(r)
		accountLists.Add(1)
		writeJSON(w, 200, map[string]any{"accounts": []map[string]any{{"_id": "A0", "platform": "facebook"}, {"_id": "A1", "platform": "tiktok", "isActive": true}, {"_id": "A2", "platform": "youtube"}}})
	})
	mux.HandleFunc("/accounts/A1/tiktok/creator-info", func(w http.ResponseWriter, r *http.Request) {
		chk(r)
		writeJSON(w, 200, map[string]any{"privacyLevels": []map[string]string{{"value": "PUBLIC_TO_EVERYONE"}},
			"postingLimits": map[string]any{"interactionSettings": map[string]any{"allow_duet": map[string]bool{"enabled": false}}}})
	})
	mux.HandleFunc("/media/presign", func(w http.ResponseWriter, r *http.Request) {
		chk(r)
		presigns.Add(1)
		writeJSON(w, 200, map[string]string{"uploadUrl": srv.URL + "/put", "publicUrl": "https://cdn.example/v.mp4"})
	})
	mux.HandleFunc("/put", func(w http.ResponseWriter, r *http.Request) {
		puts.Add(1)
		putAuth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		if len(b) != 10 || r.ContentLength != 10 {
			t.Errorf("bad put body")
		}
	})
	mux.HandleFunc("/posts", func(w http.ResponseWriter, r *http.Request) {
		chk(r)
		posts.Add(1)
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		plat := body["platforms"].([]any)[0].(map[string]any)["platform"].(string)
		gotPosts[plat], gotKeys[plat] = body, r.Header.Get("Idempotency-Key")
		if k := gotKeys[plat]; k != "2026-11-22 09:00#1-"+plat && k != "2026-11-13 18:00#1-"+plat {
			t.Errorf("bad idempotency key")
		}
		if plat == "tiktok" {
			ts, _ := body["tiktokSettings"].(map[string]any)
			_, commercial := ts["commercialContentType"]
			if ts["allow_duet"] != false || ts["allow_comment"] != true || ts["privacy_level"] != "PUBLIC_TO_EVERYONE" || commercial {
				t.Errorf("bad tiktokSettings %v", ts)
			}
		}
		switch postStatus {
		case 409:
			writeJSON(w, 409, map[string]any{"error": "dup", "details": map[string]string{"existingPostId": "P9"}})
		case 500:
			writeJSON(w, 500, map[string]string{"error": "down"})
		default:
			writeJSON(w, 201, map[string]any{"post": map[string]string{"_id": "P1", "status": "publishing"}})
		}
	})
	mux.HandleFunc("/posts/", func(w http.ResponseWriter, r *http.Request) {
		chk(r)
		id := strings.TrimPrefix(r.URL.Path, "/posts/")
		st := "publishing"
		if polls.Add(1) >= 2 {
			st = "published"
		}
		writeJSON(w, 200, map[string]any{"post": map[string]any{"_id": id, "platforms": []map[string]string{{"platform": "youtube", "status": st}, {"platform": "tiktok", "status": st}}}})
	})
	srv = httptest.NewServer(mux)
	return srv, &putAuth
}

func newZ(srv *httptest.Server) *zernio {
	z := newZernio(secret, srv.Client())
	z.base, z.pollEvery, z.pollFor = srv.URL, time.Millisecond, time.Second
	return z
}

func newTT(srv *httptest.Server) Publisher { return newZ(srv).tiktok() }

func TestTikTokSuccess(t *testing.T) {
	var posts, polls atomic.Int32
	srv, putAuth := zServer(t, 201, &posts, &polls)
	defer srv.Close()
	id, err := newTT(srv).Publish(context.Background(), testPost(t))
	if err != nil || id != "P1" || posts.Load() != 1 {
		t.Fatalf("id=%q err=%v", id, err)
	}
	if *putAuth != "" {
		t.Fatal("upload PUT carried Authorization")
	}
}

func TestTikTokExistingPost(t *testing.T) {
	var posts, polls atomic.Int32
	srv, _ := zServer(t, 409, &posts, &polls)
	defer srv.Close()
	id, err := newTT(srv).Publish(context.Background(), testPost(t))
	if err != nil || id != "P9" || posts.Load() != 1 {
		t.Fatalf("id=%q err=%v posts=%d", id, err, posts.Load())
	}
}

func TestTikTokErrorNotRetried(t *testing.T) {
	var posts, polls atomic.Int32
	srv, _ := zServer(t, 500, &posts, &polls)
	defer srv.Close()
	_, err := newTT(srv).Publish(context.Background(), testPost(t))
	noSecret(t, err)
	if !strings.Contains(err.Error(), "500") || posts.Load() != 1 {
		t.Fatalf("err=%v posts=%d", err, posts.Load())
	}
}

func TestYouTubeViaZernio(t *testing.T) {
	var posts, polls atomic.Int32
	srv, _ := zServer(t, 201, &posts, &polls)
	defer srv.Close()
	p := testPost(t)
	p.Text = "a <b> c"
	id, err := newZ(srv).youtube().Publish(context.Background(), p)
	if err != nil || id != "P1" || posts.Load() != 1 {
		t.Fatalf("id=%q err=%v", id, err)
	}
	e := gotPosts["youtube"]["platforms"].([]any)[0].(map[string]any)
	psd, _ := e["platformSpecificData"].(map[string]any)
	if e["accountId"] != "A2" || psd["title"] != "hello" || psd["visibility"] != "public" || psd["madeForKids"] != false || gotPosts["youtube"]["content"] != "a b c" || gotKeys["youtube"] != "2026-11-22 09:00#1-youtube" {
		t.Errorf("bad youtube post %v key=%q", gotPosts["youtube"], gotKeys["youtube"])
	}
}

func TestZernioUploadsFileOnce(t *testing.T) {
	var posts, polls atomic.Int32
	srv, _ := zServer(t, 201, &posts, &polls)
	defer srv.Close()
	z := newZ(srv)
	p := testPost(t)
	for _, pub := range []Publisher{z.youtube(), z.tiktok()} {
		if _, err := pub.Publish(context.Background(), p); err != nil {
			t.Fatal(err)
		}
	}
	if presigns.Load() != 1 || puts.Load() != 1 || posts.Load() != 2 || accountLists.Load() != 1 {
		t.Fatalf("presigns=%d puts=%d posts=%d accountLists=%d", presigns.Load(), puts.Load(), posts.Load(), accountLists.Load())
	}
	// a new slot (same process, as on the VM) must not reuse the previous slot's URL or account list
	p.SlotID = "2026-11-13 18:00#1"
	if _, err := z.youtube().Publish(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	if presigns.Load() != 2 || puts.Load() != 2 || accountLists.Load() != 2 {
		t.Fatalf("after new slot: presigns=%d puts=%d accountLists=%d", presigns.Load(), puts.Load(), accountLists.Load())
	}
	// same slot, a different file (TikTok gets the music version, YouTube does not): upload again
	p.File = testPost(t).File
	if _, err := z.tiktok().Publish(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	if presigns.Load() != 3 || puts.Load() != 3 {
		t.Fatalf("other file: presigns=%d puts=%d", presigns.Load(), puts.Load())
	}
}

func TestInstagramTransientPollErrorKeepsPolling(t *testing.T) {
	var pub atomic.Int32
	srv := igServer(t, "FLAKY", &pub)
	defer srv.Close()
	id, err := newIG(srv).Publish(context.Background(), testPost(t))
	if err != nil || id != "M1" || pub.Load() != 1 {
		t.Fatalf("id=%q err=%v pub=%d", id, err, pub.Load())
	}
}
