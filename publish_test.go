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

func zServer(t *testing.T, postStatus int, posts *atomic.Int32, polls *atomic.Int32) (*httptest.Server, *string) {
	var putAuth string
	var srv *httptest.Server
	mux := http.NewServeMux()
	chk := func(r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+secret {
			t.Errorf("zernio %s missing auth", r.URL.Path)
		}
	}
	mux.HandleFunc("/accounts", func(w http.ResponseWriter, r *http.Request) {
		chk(r)
		writeJSON(w, 200, map[string]any{"accounts": []map[string]any{{"_id": "A0", "platform": "facebook"}, {"_id": "A1", "platform": "tiktok", "isActive": true}}})
	})
	mux.HandleFunc("/accounts/A1/tiktok/creator-info", func(w http.ResponseWriter, r *http.Request) {
		chk(r)
		writeJSON(w, 200, map[string]any{"privacyLevels": []map[string]string{{"value": "PUBLIC_TO_EVERYONE"}},
			"postingLimits": map[string]any{"interactionSettings": map[string]any{"allow_duet": map[string]bool{"enabled": false}}}})
	})
	mux.HandleFunc("/media/presign", func(w http.ResponseWriter, r *http.Request) {
		chk(r)
		writeJSON(w, 200, map[string]string{"uploadUrl": srv.URL + "/put", "publicUrl": "https://cdn.example/v.mp4"})
	})
	mux.HandleFunc("/put", func(w http.ResponseWriter, r *http.Request) {
		putAuth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		if len(b) != 10 || r.ContentLength != 10 {
			t.Errorf("bad put body")
		}
	})
	mux.HandleFunc("/posts", func(w http.ResponseWriter, r *http.Request) {
		chk(r)
		posts.Add(1)
		if r.Header.Get("Idempotency-Key") != "2026-11-22 09:00#1-tiktok" {
			t.Errorf("bad idempotency key")
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		ts, _ := body["tiktokSettings"].(map[string]any)
		if ts["allow_duet"] != false || ts["allow_comment"] != true || ts["privacy_level"] != "PUBLIC_TO_EVERYONE" {
			t.Errorf("bad tiktokSettings %v", ts)
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
		writeJSON(w, 200, map[string]any{"post": map[string]any{"_id": id, "platforms": []map[string]string{{"platform": "tiktok", "status": st}}}})
	})
	srv = httptest.NewServer(mux)
	return srv, &putAuth
}

func newTT(srv *httptest.Server) *tiktok {
	tt := newTikTok(secret, srv.Client()).(*tiktok)
	tt.zernio, tt.pollEvery, tt.pollFor = srv.URL, time.Millisecond, time.Second
	return tt
}

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

func ytServer(t *testing.T, putStatus int, puts *atomic.Int32) *httptest.Server {
	var srv *httptest.Server
	mux := http.NewServeMux()
	mux.HandleFunc("/upload/youtube/v3/videos", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.Header.Get("Authorization") != "Bearer "+secret || body["snippet"]["title"] != "hello" || body["status"]["privacyStatus"] != "public" || r.Header.Get("X-Upload-Content-Length") != "10" {
			t.Errorf("bad init: %v %v", r.Header, body)
		}
		w.Header().Set("Location", srv.URL+"/session?upload_id=U")
		w.WriteHeader(200)
	})
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		puts.Add(1)
		b, _ := io.ReadAll(r.Body)
		if r.Header.Get("Authorization") != "" || len(b) != 10 || r.ContentLength != 10 {
			t.Errorf("bad put: auth=%q len=%d", r.Header.Get("Authorization"), len(b))
		}
		if putStatus != 200 {
			writeJSON(w, putStatus, map[string]any{"error": map[string]string{"message": "quota"}})
			return
		}
		writeJSON(w, 200, map[string]string{"id": "YT1"})
	})
	srv = httptest.NewServer(mux)
	return srv
}

func newYT(srv *httptest.Server) *youtube {
	auth := &googleAuth{tok: secret, exp: time.Unix(1<<40, 0), now: func() time.Time { return time.Unix(0, 0) }}
	y := newYouTube(auth, srv.Client()).(*youtube)
	y.ytUpload = srv.URL
	return y
}

func TestYouTubeSuccess(t *testing.T) {
	var puts atomic.Int32
	srv := ytServer(t, 200, &puts)
	defer srv.Close()
	id, err := newYT(srv).Publish(context.Background(), testPost(t))
	if err != nil || id != "YT1" {
		t.Fatalf("id=%q err=%v", id, err)
	}
}

func TestYouTubeErrorNotRetried(t *testing.T) {
	var puts atomic.Int32
	srv := ytServer(t, 403, &puts)
	defer srv.Close()
	_, err := newYT(srv).Publish(context.Background(), testPost(t))
	noSecret(t, err)
	if !strings.Contains(err.Error(), "403") || !strings.Contains(err.Error(), "quota") || puts.Load() != 1 {
		t.Fatalf("err=%v puts=%d", err, puts.Load())
	}
}

func TestYouTubeSessionTokenHost(t *testing.T) {
	for loc, want := range map[string]bool{
		"https://www.googleapis.com/upload/youtube/v3/videos?upload_id=U": true,
		"http://www.googleapis.com/x":                                     false,
		"https://evil.example/x":                                          false,
		"https://www.googleapis.com.evil.example/x":                       false,
	} {
		if sessionGetsToken(loc) != want {
			t.Errorf("%s: want %v", loc, want)
		}
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
