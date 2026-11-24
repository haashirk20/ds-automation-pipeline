package main

import (
	"slices"
	"strings"
	"testing"
)

func baseSpec() renderSpec {
	return renderSpec{Video: "/t/video", Music: "/t/music", Out: "/t/out.mp4", Duration: 20, MusicVolume: 0.25}
}

func mustArgs(t *testing.T, s renderSpec) []string {
	t.Helper()
	return ffmpegArgs(s)
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
	s.Overlay = "/t/text.png"
	a := mustArgs(t, s)
	fc := argAfter(a, "-filter_complex")
	for _, want := range []string{"scale=1080:1920:force_original_aspect_ratio=decrease", "pad=1080:1920", "setsar=1",
		"[0:v]", "[base];[2:v]format=rgba,split[t][s];", "colorchannelmixer=rr=0:gg=0:bb=0:aa=0.6,boxblur=6[sh]",
		"[base][sh]overlay=x=(W-w)/2+3:y=(H-h)*0.72+3[b2];[b2][t]overlay=x=(W-w)/2:y=(H-h)*0.72[v]", "[1:a]anull[a]"} {
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
	if i := slices.Index(a, "/t/text.png"); i < 0 || a[i-1] != "-i" || slices.Index(a, "/t/music") > i {
		t.Errorf("overlay must be input 2: %v", a)
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
	if strings.Contains(fc, "overlay") || strings.Count(strings.Join(mustArgs(t, s), " "), " -i ") != 2 {
		t.Error("no overlay and no third input when burn is off")
	}
	if !strings.Contains(fc, "setsar=1[v];") {
		t.Errorf("video label %s", fc)
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

func TestBuildPost(t *testing.T) {
	set := Settings{Hashtags: "#a #b", YouTubePrivacy: "public"}
	p := buildPost("Hi <b>\nsecond", "P", set, "id", "/f.mp4")
	if p.Text != "Hi <b>\nsecond\n\n#a #b" || p.Title != "Hi b #a #b" {
		t.Errorf("%+v", p)
	}
	set.Hashtags = strings.Repeat("#x ", 40)
	if n := strings.Count(buildPost("c", "P", set, "id", "f").Text, "#"); n != 30 {
		t.Errorf("hashtags %d", n)
	}
	set.Hashtags = ""
	if got := buildPost("", "Velvet", set, "id", "f").Title; got != "Velvet" {
		t.Errorf("title %q", got)
	}
	if got := buildPost("", "", set, "id", "f").Title; got != "New video" {
		t.Errorf("title %q", got)
	}
	long := buildPost(strings.Repeat("é", 150), "P", set, "id", "f")
	if len([]rune(long.Title)) != 100 {
		t.Errorf("title len %d", len([]rune(long.Title)))
	}
}

func TestPangoArgs(t *testing.T) {
	got := pangoArgs("comment BOOK 📖✨", "/t/text.png", "DejaVu Sans Bold")
	want := []string{"-q", "-o", "/t/text.png", "--background=transparent", "--foreground=white",
		"--font=DejaVu Sans Bold 48", "--width=960", "--wrap=word-char", "--align=center",
		"--margin=20", "--pixels", "--dpi=72", "--text=comment BOOK 📖✨"}
	if !slices.Equal(got, want) {
		t.Errorf("%q", got)
	}
}

func TestBurnText(t *testing.T) {
	if got := burnText("  a\x00b\x1b\tc\nd 📖✨ \r"); got != "abc\nd 📖✨" {
		t.Errorf("%q", got)
	}
	if got := []rune(burnText(strings.Repeat("é", 200))); len(got) != 150 {
		t.Errorf("len %d", len(got))
	}
	if got := burnText("1\n2\n3\n4\n5\n6\n7\n8"); got != "1\n2\n3\n4\n5\n6" {
		t.Errorf("lines %q", got)
	}
	// cut at the last space, so the emoji pair after the limit is not split
	in := strings.Repeat("word ", 29) + "ab👨‍👩‍👧 tail" // the family emoji straddles rune 150
	if got := burnText(in); got != strings.TrimSpace(strings.Repeat("word ", 29)) {
		t.Errorf("cut %q", got)
	}
}
