package main

import (
	"slices"
	"strings"
	"testing"
)

func baseSpec() renderSpec {
	return renderSpec{Video: "/t/video", Music: "/t/music", Out: "/t/out.mp4", Duration: 20,
		TextFile: "/t/caption.txt", Font: "/f/font.ttf", MusicVolume: 0.25}
}

func mustArgs(t *testing.T, s renderSpec) []string {
	t.Helper()
	a, err := ffmpegArgs(s)
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func argAfter(args []string, flag string) string {
	i := slices.Index(args, flag)
	if i < 0 || i+1 >= len(args) {
		return ""
	}
	return args[i+1]
}

func TestFFmpegArgsReplace(t *testing.T) {
	s := baseSpec()
	s.Burn = true
	a := mustArgs(t, s)
	fc := argAfter(a, "-filter_complex")
	for _, want := range []string{"scale=1080:1920:force_original_aspect_ratio=decrease", "pad=1080:1920", "setsar=1",
		"drawtext=fontfile='/f/font.ttf':textfile='/t/caption.txt':expansion=none", "[1:a]anull[a]"} {
		if !strings.Contains(fc, want) {
			t.Errorf("filter missing %q in %s", want, fc)
		}
	}
	if strings.Contains(fc, "amix") {
		t.Error("replace must not mix")
	}
	if argAfter(a, "-t") != "20.000" || !slices.Contains(a, "-shortest") || argAfter(a, "-stream_loop") != "-1" {
		t.Errorf("args %v", a)
	}
	// -stream_loop must come right before the music input
	i := slices.Index(a, "-stream_loop")
	if a[i+2] != "-i" || a[i+3] != "/t/music" {
		t.Errorf("stream_loop not on music: %v", a)
	}
	if a[len(a)-1] != "/t/out.mp4" || argAfter(a, "-c:v") != "libx264" || argAfter(a, "-c:a") != "aac" {
		t.Errorf("args %v", a)
	}
}

func TestFFmpegArgsKeepAudio(t *testing.T) {
	s := baseSpec()
	s.KeepAudio, s.HasAudio = true, true
	fc := argAfter(mustArgs(t, s), "-filter_complex")
	if !strings.Contains(fc, "[1:a]volume=0.25[m];[0:a][m]amix=inputs=2:duration=first:normalize=0[a]") {
		t.Errorf("filter %s", fc)
	}
	if strings.Contains(fc, "drawtext") {
		t.Error("no drawtext when burn is off")
	}
	s.HasAudio = false // keepaudio without an audio stream falls back to replace
	fc = argAfter(mustArgs(t, s), "-filter_complex")
	if strings.Contains(fc, "amix") || !strings.Contains(fc, "[1:a]anull[a]") {
		t.Errorf("filter %s", fc)
	}
}

func TestFFmpegArgsDurationCap(t *testing.T) {
	s := baseSpec()
	s.Duration = 300
	if got := argAfter(mustArgs(t, s), "-t"); got != "90.000" {
		t.Errorf("-t %s", got)
	}
}

func TestEscapeFilterPath(t *testing.T) {
	if got := escapeFilterPath(`C:\a`); got != `C\:\\a` {
		t.Errorf("%s", got)
	}
}

func TestStripSymbols(t *testing.T) {
	in := "Wow 😍 100% ❤️ café 👨‍👩‍👧 done\nline2"
	got := strings.Join(strings.Fields(stripSymbols(in)), " ")
	if got != "Wow 100% café done line2" {
		t.Errorf("%q", got)
	}
}

func TestWrapCaption(t *testing.T) {
	got := wrapCaption("this is a fairly long caption that needs wrapping", 24)
	for _, l := range strings.Split(got, "\n") {
		if len([]rune(l)) > 24 {
			t.Errorf("line too long: %q", l)
		}
	}
	if got != "this is a fairly long\ncaption that needs\nwrapping" {
		t.Errorf("%q", got)
	}
	if got := wrapCaption("a\nb", 24); got != "a\nb" {
		t.Errorf("newline lost: %q", got)
	}
	if got := wrapCaption(strings.Repeat("x", 30), 24); got != strings.Repeat("x", 24)+"\n"+strings.Repeat("x", 6) {
		t.Errorf("long word: %q", got)
	}
}

func TestBuildPost(t *testing.T) {
	set := Settings{Hashtags: "#a #b", YouTubePrivacy: "public"}
	p := buildPost("Hi <b>\nsecond", set, "id", "/f.mp4")
	if p.Text != "Hi <b>\nsecond\n\n#a #b" || p.Title != "Hi b #a #b" {
		t.Errorf("%+v", p)
	}
	set.Hashtags = strings.Repeat("#x ", 40)
	if n := strings.Count(buildPost("c", set, "id", "f").Text, "#"); n != 30 {
		t.Errorf("hashtags %d", n)
	}
	long := buildPost(strings.Repeat("é", 150), set, "id", "f")
	if len([]rune(long.Title)) != 100 {
		t.Errorf("title len %d", len([]rune(long.Title)))
	}
}

func TestFFmpegArgsRefusesQuote(t *testing.T) {
	s := baseSpec()
	s.Burn, s.TextFile = true, "/t/it's.txt"
	if _, err := ffmpegArgs(s); err == nil {
		t.Fatal("want error")
	}
	s.TextFile, s.Font = "/t/c.txt", "/f/o'x.ttf"
	if _, err := ffmpegArgs(s); err == nil {
		t.Fatal("want error")
	}
	s.Burn = false
	if _, err := ffmpegArgs(s); err != nil {
		t.Fatal("quote irrelevant when not burning")
	}
}

func TestCapLines(t *testing.T) {
	if got := capLines("a\nb\nc", 5); got != "a\nb\nc" {
		t.Error(got)
	}
	if got := capLines("1\n2\n3\n4\n5\n6\n7", 5); got != "1\n2\n3\n4\n5…" {
		t.Errorf("%q", got)
	}
}
