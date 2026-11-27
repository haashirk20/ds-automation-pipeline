package main

import (
	"slices"
	"strings"
	"testing"
)

func baseSpec() renderSpec {
	return renderSpec{Video: "/t/video", Music: "/t/music", NoMusic: "/t/nomusic.mp4", Out: "/t/out.mp4", Duration: 20, MusicVolume: 0.25}
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

func TestFFmpegArgsFirstPass(t *testing.T) {
	s := baseSpec()
	s.Overlay, s.HasAudio = "/t/text.png", true
	a := mustArgs(t, s)
	fc := argAfter(a, "-filter_complex")
	for _, want := range []string{"scale=1080:1920:force_original_aspect_ratio=decrease", "pad=1080:1920", "setsar=1",
		"[0:v]", "[base];[1:v]format=rgba,split[t][s];",
		"colorchannelmixer=rr=0:gg=0:bb=0,format=yuva444p,dilation,dilation,dilation,dilation[o]",
		"[base][o]overlay=x=(W-w)/2:y=200[b2];[b2][t]overlay=x=(W-w)/2:y=200[v]"} {
		if !strings.Contains(fc, want) {
			t.Errorf("filter missing %q in %s", want, fc)
		}
	}
	if slices.Contains(a, "/t/music") || strings.Contains(fc, "[1:a]") {
		t.Errorf("first pass must not use the music: %v", a)
	}
	if i := slices.Index(a, "/t/text.png"); i < 0 || a[i-1] != "-i" {
		t.Errorf("overlay must be input 1: %v", a)
	}
	if argAfter(a, "-t") != "20.000" || argAfter(a, "-c:v") != "libx264" || a[len(a)-1] != "/t/nomusic.mp4" {
		t.Errorf("args %v", a)
	}
	if !strings.Contains(strings.Join(a, " "), "-map [v] -map 0:a:0 -c:a aac") {
		t.Errorf("video sound must be kept: %v", a)
	}
	s.HasAudio, s.Overlay = false, ""
	a = mustArgs(t, s)
	if !slices.Contains(a, "-an") || strings.Contains(argAfter(a, "-filter_complex"), "overlay") || strings.Count(strings.Join(a, " "), " -i ") != 1 {
		t.Errorf("no audio, no overlay: %v", a)
	}
}

func TestMusicArgs(t *testing.T) {
	s := baseSpec()
	s.HasAudio = true
	a := musicArgs(s)
	if fc := argAfter(a, "-filter_complex"); fc != "[1:a]volume=0.25[m];[0:a][m]amix=inputs=2:duration=first:normalize=0[a]" {
		t.Errorf("filter %s", fc)
	}
	// -stream_loop must come right before the music input; the video is copied, not re-encoded
	i := slices.Index(a, "-stream_loop")
	if i < 0 || a[i+1] != "-1" || a[i+2] != "-i" || a[i+3] != "/t/music" || argAfter(a, "-i") != "/t/nomusic.mp4" {
		t.Errorf("inputs %v", a)
	}
	if argAfter(a, "-c:v") != "copy" || argAfter(a, "-t") != "20.000" || !slices.Contains(a, "-shortest") || a[len(a)-1] != "/t/out.mp4" {
		t.Errorf("args %v", a)
	}
	s.HasAudio = false // no audio stream: music only
	if fc := argAfter(musicArgs(s), "-filter_complex"); fc != "[1:a]anull[a]" {
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
	// no burn line: caption + hashtags as before, title without hashtags
	p := buildPost("Hi <b>\nsecond", "", "P", set, "id", "/f.mp4")
	if p.Text != "Hi <b>\nsecond\n\n#a #b" || p.Title != "Hi b" {
		t.Errorf("%+v", p)
	}
	// burn line leads the text and is the title, without hashtags, newlines or <>
	p = buildPost("Cap", "comment \\n BOOK #fyp\nnow <3", "P", set, "id", "f")
	if p.Text != "comment BOOK now 3\n\nCap\n\n#a #b" || p.Title != "comment BOOK now 3" {
		t.Errorf("%+v", p)
	}
	// burn-line hashtags never add to the IG 30-hashtag count
	set.Hashtags = strings.Repeat("#x ", 40)
	if n := strings.Count(buildPost("c", strings.Repeat("#y ", 20), "P", set, "id", "f").Text, "#"); n != 30 {
		t.Errorf("hashtags %d", n)
	}
	set.Hashtags = "#a #b"
	// burn line is only hashtags: title falls back to the caption line
	if got := buildPost("Cap line #z\nmore", "#only", "P", set, "id", "f").Title; got != "Cap line" {
		t.Errorf("title %q", got)
	}
	set.Hashtags = strings.Repeat("#x ", 40)
	if n := strings.Count(buildPost("c", "", "P", set, "id", "f").Text, "#"); n != 30 {
		t.Errorf("hashtags %d", n)
	}
	set.Hashtags = ""
	if got := buildPost("", "", "Velvet", set, "id", "f").Title; got != "Velvet" {
		t.Errorf("title %q", got)
	}
	if got := buildPost("", "", "", set, "id", "f"); got.Title != "New video" || got.Text != "" {
		t.Errorf("%+v", got)
	}
	if got := buildPost("", "burn", "", set, "id", "f").Text; got != "burn" {
		t.Errorf("text %q", got)
	}
	long := buildPost("c", strings.Repeat("é", 150), "P", set, "id", "f")
	if len([]rune(long.Title)) != 100 {
		t.Errorf("title len %d", len([]rune(long.Title)))
	}
}

func TestPangoArgs(t *testing.T) {
	got := pangoArgs("comment BOOK 📖✨", "/t/text.png", "Montserrat SemiBold")
	want := []string{"-q", "-o", "/t/text.png", "--background=transparent", "--foreground=white",
		"--font=Montserrat SemiBold 64", "--width=960", "--wrap=word-char", "--align=center",
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
