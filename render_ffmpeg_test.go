//go:build ffmpeg

package main

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func gen(t *testing.T, args ...string) {
	t.Helper()
	if out, err := exec.Command("ffmpeg", append([]string{"-y", "-loglevel", "error"}, args...)...).CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg %v: %v\n%s", args, err, out)
	}
}

func TestRenderReal(t *testing.T) {
	dir := t.TempDir()
	withAudio := filepath.Join(dir, "a.mp4")
	noAudio := filepath.Join(dir, "n.mp4")
	music := filepath.Join(dir, "m.mp3")
	gen(t, "-f", "lavfi", "-i", "testsrc=duration=5:size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=330:duration=5",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", withAudio)
	gen(t, "-f", "lavfi", "-i", "testsrc=duration=5:size=640x360:rate=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", noAudio)
	gen(t, "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", music) // shorter than video: must loop

	cases := []struct {
		name      string
		video     string
		keep, has bool
		caption   string
	}{
		{"replace", withAudio, false, true, ""},
		{"keepaudio", withAudio, true, true, ""},
		{"keepaudio without audio stream", noAudio, true, false, ""},
		{"text with percent and quote", withAudio, false, true, "100% real it's: a \\ test"},
		{"colour emoji text", withAudio, false, true, "comment BOOK if you want one! 📖✨"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			png := ""
			if c.caption != "" {
				png = filepath.Join(dir, "text.png")
				if err := runCmd(context.Background(), "pango-view", pangoArgs(burnText(c.caption), png, defaultFont)); err != nil {
					t.Fatal(err)
				}
			}
			out := filepath.Join(dir, "out-"+filepath.Base(t.Name())+".mp4")
			pr, err := probe(context.Background(), "ffprobe", c.video)
			if err != nil || pr.HasAudio != c.has {
				t.Fatalf("probe %+v %v", pr, err)
			}
			args := ffmpegArgs(renderSpec{Video: c.video, Music: music, Out: out, Duration: pr.Duration,
				KeepAudio: c.keep, HasAudio: pr.HasAudio, Overlay: png, MusicVolume: 0.25})
			if err := runCmd(context.Background(), "ffmpeg", args); err != nil {
				t.Fatal(err)
			}
			if fd := os.Getenv("FRAME_DIR"); fd != "" && c.name == "colour emoji text" {
				gen(t, "-ss", "1", "-i", out, "-frames:v", "1", filepath.Join(fd, "frame.png"))
			}
			b, err := exec.Command("ffprobe", "-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height", "-of", "json", out).Output()
			if err != nil {
				t.Fatal(err)
			}
			var j struct {
				Streams []struct {
					CodecName string `json:"codec_name"`
					CodecType string `json:"codec_type"`
					Width     int
					Height    int
				}
			}
			json.Unmarshal(b, &j)
			got := map[string]string{}
			for _, s := range j.Streams {
				got[s.CodecType] = s.CodecName
				if s.CodecType == "video" && (s.Width != 1080 || s.Height != 1920) {
					t.Errorf("size %dx%d", s.Width, s.Height)
				}
			}
			if got["video"] != "h264" || got["audio"] != "aac" {
				t.Errorf("streams %v", got)
			}
		})
	}
}
