package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"math/rand/v2"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakePub records Publish calls and checks the slot was claimed in Drive first.
type fakePub struct {
	name    string
	fail    bool
	calls   []Post
	claimed func(slotID string) bool
	t       *testing.T
}

func (p *fakePub) Name() string { return p.name }
func (p *fakePub) Publish(ctx context.Context, post Post) (string, error) {
	if !p.claimed(post.SlotID) {
		p.t.Errorf("%s: publish before claim of %s", p.name, post.SlotID)
	}
	if _, err := os.Stat(post.File); err != nil {
		p.t.Errorf("%s: media missing: %v", p.name, err)
	}
	p.calls = append(p.calls, post)
	if p.fail {
		return "", errors.New("boom")
	}
	return p.name + "-id", nil
}

type tickEnv struct {
	f    *fkDrive
	tk   *ticker
	pubs map[string]*fakePub
	now  time.Time
}

// fake ffprobe/ffmpeg shell scripts stand in for the real tools
func writeTools(t *testing.T, probeJSON string) (ffmpeg, ffprobe, pango string) {
	dir := t.TempDir()
	ffprobe = filepath.Join(dir, "ffprobe")
	ffmpeg = filepath.Join(dir, "ffmpeg")
	os.WriteFile(ffprobe, []byte("#!/bin/sh\ncat <<'EOF'\n"+probeJSON+"\nEOF\n"), 0o755)
	os.WriteFile(ffmpeg, []byte("#!/bin/sh\nfor a; do last=$a; done\necho rendered > \"$last\"\n"), 0o755)
	pango = filepath.Join(dir, "pango-view")
	os.WriteFile(pango, []byte("#!/bin/sh\necho \"$@\" > \"$0.args\"\nwhile [ $# -gt 0 ]; do [ \"$1\" = -o ] && out=$2; shift; done\necho png > \"$out\"\n"), 0o755)
	return
}

const probeLong = `{"format":{"duration":"12.5"},"streams":[{"codec_type":"video"},{"codec_type":"audio"}]}`

func newTickEnv(t *testing.T, settings, probeJSON string) *tickEnv {
	f := newFkDrive(t)
	f.add("set", "settings", docMime, "root", settings)
	f.add("cap", "captions", docMime, "root", "# c\nonly caption\n")
	f.add("st", "state.json", "application/json", "root", `{"claims":{}}`)
	f.add("pr", "products", docMime, "root", "[Velvet Tarot Deck]\nVelvet caption\n")
	f.add("vf", "videos", folderMime, "root", "")
	f.add("pf", "Velvet Tarot Deck ", folderMime, "vf", "")
	f.add("mf", "music", folderMime, "root", "")
	f.add("v1", "a.mp4", "video/mp4", "pf", "VID")
	f.add("m1", "a.mp3", "audio/mpeg", "mf", "MUS")
	ffmpeg, ffprobe, pango := writeTools(t, probeJSON)
	e := &tickEnv{f: f, pubs: map[string]*fakePub{}, now: time.Date(2026, 11, 12, 9, 30, 0, 0, time.UTC)}
	e.tk = &ticker{d: f.drive(), root: "root", pubs: map[string]Publisher{}, font: "DejaVu Sans Bold", pango: pango,
		log: slog.New(slog.NewJSONHandler(io.Discard, nil)), ffmpeg: ffmpeg, ffprobe: ffprobe}
	for _, n := range allPlatforms {
		p := &fakePub{name: n, t: t, claimed: e.claimed}
		e.pubs[n] = p
		e.tk.pubs[n] = p
	}
	return e
}

func (e *tickEnv) claimed(id string) bool {
	var st state
	json.Unmarshal([]byte(e.f.get("st").content), &st)
	_, ok := st.Claims[id]
	return ok
}

const settingsOne = "times = 09:00\ntimezone = UTC\nhashtags = #x\nplatforms = youtube, facebook\n"

func TestTickPublishesOnceThenClaimBlocks(t *testing.T) {
	e := newTickEnv(t, settingsOne, probeLong)
	ctx := context.Background()
	if due, err := e.tk.isDue(ctx, e.now); err != nil || !due {
		t.Fatalf("due=%v err=%v", due, err)
	}
	if err := e.tk.tick(ctx, e.now); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"youtube", "facebook"} {
		if len(e.pubs[n].calls) != 1 {
			t.Fatalf("%s calls %d", n, len(e.pubs[n].calls))
		}
	}
	if len(e.pubs["tiktok"].calls) != 0 {
		t.Fatal("tiktok is not enabled")
	}
	c := e.pubs["youtube"].calls[0]
	if c.Text != "Velvet caption\n\n#x" || c.Title != "Velvet caption #x" || c.SlotID != "2026-11-12 09:00#1" || c.Privacy != "public" {
		t.Fatalf("%+v", c)
	}
	if _, err := os.Stat(c.File); err == nil {
		t.Fatal("temp dir not removed")
	}
	// run again: claimed, nothing posts, nothing due
	if err := e.tk.tick(ctx, e.now.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if len(e.pubs["youtube"].calls) != 1 {
		t.Fatal("double post")
	}
	if due, _ := e.tk.isDue(ctx, e.now); due {
		t.Fatal("still due after claim")
	}
}

func TestTickOnePlatformFailsOthersRun(t *testing.T) {
	e := newTickEnv(t, settingsOne, probeLong)
	e.pubs["youtube"].fail = true
	err := e.tk.tick(context.Background(), e.now)
	if err == nil {
		t.Fatal("want non-nil exit error")
	}
	if len(e.pubs["facebook"].calls) != 1 {
		t.Fatal("facebook must still run")
	}
	if len(e.pubs["youtube"].calls) != 1 {
		t.Fatal("failed publish must not be retried")
	}
}

func TestTickDryRunSkipsPublishAndClaim(t *testing.T) {
	e := newTickEnv(t, settingsOne, probeLong)
	e.tk.dryRun = true
	if err := e.tk.tick(context.Background(), e.now); err != nil {
		t.Fatal(err)
	}
	if len(e.pubs["youtube"].calls)+len(e.pubs["facebook"].calls) != 0 {
		t.Fatal("dry run published")
	}
	if e.claimed("2026-11-12 09:00#1") {
		t.Fatal("dry run must not claim")
	}
}

func TestTickClaimFailureAbortsBeforePublish(t *testing.T) {
	e := newTickEnv(t, settingsOne, probeLong)
	e.f.failUpdate = true
	if err := e.tk.tick(context.Background(), e.now); err == nil {
		t.Fatal("want error")
	}
	for _, p := range e.pubs {
		if len(p.calls) != 0 {
			t.Fatal("published without a claim")
		}
	}
}

func TestTickPausedOrBadSettings(t *testing.T) {
	e := newTickEnv(t, settingsOne+"paused = yes\n", probeLong)
	if err := e.tk.tick(context.Background(), e.now); err != nil || len(e.pubs["youtube"].calls) != 0 {
		t.Fatalf("paused: err=%v", err)
	}
	e = newTickEnv(t, settingsOne+"bogus = 1\n", probeLong)
	if err := e.tk.tick(context.Background(), e.now); err == nil || len(e.pubs["youtube"].calls) != 0 {
		t.Fatal("bad settings must error and post nothing")
	}
}

func TestTickShortVideoFailsWithoutClaim(t *testing.T) {
	short := `{"format":{"duration":"2.0"},"streams":[{"codec_type":"video"}]}`
	e := newTickEnv(t, settingsOne, short)
	if err := e.tk.tick(context.Background(), e.now); err == nil {
		t.Fatal("want error")
	}
	if len(e.pubs["youtube"].calls) != 0 {
		t.Fatal("must not publish")
	}
	if e.claimed("2026-11-12 09:00#1") {
		t.Fatal("render failure must not claim")
	}
}

func TestTickMissingCredentialsFailsBeforeClaim(t *testing.T) {
	e := newTickEnv(t, settingsOne, probeLong)
	delete(e.tk.pubs, "facebook")
	if err := e.tk.tick(context.Background(), e.now); err == nil || !strings.Contains(err.Error(), "credentials") {
		t.Fatalf("err %v", err)
	}
	if len(e.pubs["youtube"].calls) != 0 || e.claimed("2026-11-12 09:00#1") {
		t.Fatal("missing credentials must fail before claim and publish")
	}
}

func (e *tickEnv) pangoArgs() string {
	b, _ := os.ReadFile(e.tk.pango + ".args")
	return string(b)
}

func TestTickBurnTextFromCaptionsDocAndPinned(t *testing.T) {
	e := newTickEnv(t, settingsOne, probeLong)
	if err := e.tk.tick(context.Background(), e.now); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(e.pangoArgs(), "--text=only caption") {
		t.Errorf("pango args %s", e.pangoArgs())
	}
	e = newTickEnv(t, settingsOne+"burn_text = comment BOOK \\n now 📖\n", probeLong)
	if err := e.tk.tick(context.Background(), e.now); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(e.pangoArgs(), "--text=comment BOOK \n now 📖") {
		t.Errorf("pango args %s", e.pangoArgs())
	}
	if c := e.pubs["youtube"].calls[0]; strings.Contains(c.Text, "comment BOOK") {
		t.Errorf("burned text leaked into post text: %q", c.Text)
	}
	e = newTickEnv(t, settingsOne+"burn_caption = no\n", probeLong)
	if err := e.tk.tick(context.Background(), e.now); err != nil {
		t.Fatal(err)
	}
	if e.pangoArgs() != "" {
		t.Error("no burn: pango-view must not run")
	}
}

func TestTickFallsBackToDefaultCaption(t *testing.T) {
	// loose video in videos/ has no product entry
	e := newTickEnv(t, settingsOne+"default_caption = Shop now\n", probeLong)
	e.f.get("v1").parent = "vf"
	if err := e.tk.tick(context.Background(), e.now); err != nil {
		t.Fatal(err)
	}
	if c := e.pubs["youtube"].calls[0]; c.Text != "Shop now\n\n#x" {
		t.Errorf("%q", c.Text)
	}
	// product folder exists but has no entry, and default_caption is empty
	e = newTickEnv(t, settingsOne, probeLong)
	e.f.get("pf").name = "Other"
	if err := e.tk.tick(context.Background(), e.now); err != nil {
		t.Fatal(err)
	}
	if c := e.pubs["youtube"].calls[0]; c.Text != "#x" || c.Title != "#x" {
		t.Errorf("%+v", c)
	}
}

func TestTickProductsDocProblemsFailBeforeClaim(t *testing.T) {
	e := newTickEnv(t, settingsOne, probeLong)
	e.f.get("pr").name = "gone"
	if err := e.tk.tick(context.Background(), e.now); err == nil || !strings.Contains(err.Error(), "products doc missing: run uploader init") {
		t.Fatalf("err %v", err)
	}
	e = newTickEnv(t, settingsOne, probeLong)
	e.f.get("pr").content = "[A]\nx\n[A]\ny"
	if err := e.tk.tick(context.Background(), e.now); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("err %v", err)
	}
	if e.claimed("2026-11-12 09:00#1") || len(e.pubs["youtube"].calls) != 0 {
		t.Fatal("must fail before claim")
	}
}

func TestPickProductThenVideo(t *testing.T) {
	vs := func(n int) []driveFile { return make([]driveFile, n) }
	cs := []cand{{"A", vs(1)}, {"B", vs(9)}}
	// fixed source: first product, then dropping it when its last video is used
	zero := func(int) int { return 0 }
	p, _, rest := pick(cs, zero)
	if p != "A" || len(rest) != 1 || rest[0].product != "B" || len(cs[0].vids) != 1 {
		t.Fatalf("%q %v", p, rest)
	}
	// products are equally likely whatever their video count
	r := rand.New(rand.NewPCG(1, 2))
	n := 0
	for i := 0; i < 4000; i++ {
		if p, _, _ := pick(cs, r.IntN); p == "A" {
			n++
		}
	}
	if n < 1800 || n > 2200 {
		t.Errorf("A picked %d/4000, want about half", n)
	}
}
