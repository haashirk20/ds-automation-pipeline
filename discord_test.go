package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDiscordText(t *testing.T) {
	res := []result{{platform: "youtube", id: "Y1"}, {platform: "facebook", err: errors.New("HTTP 403")}}
	got := discordText("2026-11-24 16:00#1", "Lamp", "comment LAMP 💡", "Cozy lamp\n\n#fyp", false, res, true)
	for _, want := range []string{"**Posted** · Lamp · 2026-11-24 16:00#1", "✅ youtube: Y1", "❌ facebook: HTTP 403", "On video: comment LAMP 💡", "Caption:\nCozy lamp"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in %q", want, got)
		}
	}
	got = discordText("s", "", "", strings.Repeat("x", 5000), true, []result{{platform: "tiktok"}}, false)
	if !strings.Contains(got, "Dry run") || !strings.Contains(got, "(loose video)") || !strings.Contains(got, "⏭️ tiktok") ||
		!strings.Contains(got, "not attached") || len([]rune(got)) > 1900 {
		t.Errorf("%q", got[:200])
	}
	if !isDiscordWebhook("https://discord.com/api/webhooks/1/abc") || isDiscordWebhook("https://evil.example/api/webhooks/1") {
		t.Error("webhook URL check")
	}
}

func TestNotifyDiscordAttachesVideo(t *testing.T) {
	var gotPayload map[string]any
	var gotFile []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength <= 0 {
			t.Error("no Content-Length: the body must not be chunked")
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Fatal(err)
		}
		json.Unmarshal([]byte(r.FormValue("payload_json")), &gotPayload)
		f, _, err := r.FormFile("files[0]")
		if err != nil {
			t.Fatal(err)
		}
		gotFile, _ = io.ReadAll(f)
		w.WriteHeader(204)
	}))
	defer srv.Close()
	var logs bytes.Buffer
	tk := &ticker{discord: srv.URL + "/api/webhooks/1/SECRET", hc: srv.Client(), log: slog.New(slog.NewJSONHandler(&logs, nil))}
	p := testPost(t)
	p.Product = "Lamp"
	tk.notifyDiscord(context.Background(), slot{ID: "s1"}, p, []result{{platform: "youtube", id: "Y1"}})
	if string(gotFile) != "0123456789" {
		t.Fatalf("file %q", gotFile)
	}
	if c, _ := gotPayload["content"].(string); !strings.Contains(c, "✅ youtube: Y1") {
		t.Fatalf("payload %v", gotPayload)
	}
	if am, _ := gotPayload["allowed_mentions"].(map[string]any); am == nil {
		t.Fatal("allowed_mentions missing")
	}

	// a failing webhook only logs, and never logs the URL token
	srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) })
	tk.notifyDiscord(context.Background(), slot{ID: "s2"}, p, nil)
	tk.discord = "http://127.0.0.1:1/api/webhooks/1/SECRET"
	tk.notifyDiscord(context.Background(), slot{ID: "s3"}, p, nil)
	if strings.Contains(logs.String(), "SECRET") || strings.Count(logs.String(), "discord webhook failed") != 2 {
		t.Fatalf("logs %s", logs.String())
	}
}
