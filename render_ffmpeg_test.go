//go:build ffmpeg

package main

import (
	"context"
	"encoding/json"
	"image/png"
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
	plain := filepath.Join(dir, "p.mp4") // grey, so any colour in the frame comes from the text
	music := filepath.Join(dir, "m.mp3")
	gen(t, "-f", "lavfi", "-i", "testsrc=duration=5:size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=330:duration=5",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", withAudio)
	gen(t, "-f", "lavfi", "-i", "testsrc=duration=5:size=640x360:rate=25", "-c:v", "libx264", "-pix_fmt", "yuv420p", noAudio)
	gen(t, "-f", "lavfi", "-i", "color=c=gray:duration=5:size=640x360:rate=25", "-f", "lavfi", "-i", "sine=frequency=330:duration=5",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", plain)
	gen(t, "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", music) // shorter than video: must loop

	cases := []struct {
		name    string
		video   string
		has     bool
		caption string
	}{
		{"mix with video audio", withAudio, true, ""},
		{"no audio stream", noAudio, false, ""},
		{"text with percent and quote", withAudio, true, "100% real it's: a \\ test"},
		{"colour emoji text", plain, true, "comment BOOK if you want one! 📖✨"},
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
			nomusic := filepath.Join(dir, "nm-"+filepath.Base(t.Name())+".mp4")
			pr, err := probe(context.Background(), "ffprobe", c.video)
			if err != nil || pr.HasAudio != c.has {
				t.Fatalf("probe %+v %v", pr, err)
			}
			spec := renderSpec{Video: c.video, Music: music, NoMusic: nomusic, Out: out, Duration: pr.Duration,
				HasAudio: pr.HasAudio, Overlay: png, MusicVolume: 0.25}
			if err := runCmd(context.Background(), "ffmpeg", ffmpegArgs(spec)); err != nil {
				t.Fatal(err)
			}
			if err := runCmd(context.Background(), "ffmpeg", musicArgs(spec)); err != nil {
				t.Fatal(err)
			}
			if nm, err := probe(context.Background(), "ffprobe", nomusic); err != nil || nm.HasAudio != c.has {
				t.Fatalf("no-music file: %+v %v", nm, err)
			}
			if fd := os.Getenv("FRAME_DIR"); fd != "" && c.name == "colour emoji text" {
				frame := filepath.Join(fd, "frame.png")
				gen(t, "-ss", "1", "-i", out, "-frames:v", "1", frame)
				requireColour(t, frame)
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

// requireColour fails unless the frame has a pixel with clearly unequal R, G, B:
// white text, black shadow and a grey video alone would not, a colour emoji does.
func requireColour(t *testing.T, path string) {
	t.Helper()
	fh, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer fh.Close()
	img, err := png.Decode(fh)
	if err != nil {
		t.Fatal(err)
	}
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			r, g, bl, _ := img.At(x, y).RGBA()
			hi, lo := max(r, g, bl)>>8, min(r, g, bl)>>8
			if hi-lo > 60 {
				return
			}
		}
	}
	t.Error("no coloured pixel: emoji did not render in colour")
}
