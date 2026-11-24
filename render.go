package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"
)

const maxOutSeconds = 90

type probeResult struct {
	Duration float64
	HasAudio bool
}

func probe(ctx context.Context, ffprobe, path string) (probeResult, error) {
	out, err := exec.CommandContext(ctx, ffprobe, "-v", "error",
		"-show_entries", "format=duration:stream=codec_type", "-of", "json", path).Output()
	if err != nil {
		return probeResult{}, fmt.Errorf("ffprobe: %w", err)
	}
	var j struct {
		Format  struct{ Duration string }
		Streams []struct {
			CodecType string `json:"codec_type"`
		}
	}
	if err := json.Unmarshal(out, &j); err != nil {
		return probeResult{}, fmt.Errorf("ffprobe: bad JSON")
	}
	d, err := strconv.ParseFloat(j.Format.Duration, 64)
	if err != nil {
		return probeResult{}, fmt.Errorf("ffprobe: no duration")
	}
	r := probeResult{Duration: d}
	for _, s := range j.Streams {
		if s.CodecType == "audio" {
			r.HasAudio = true
		}
	}
	return r, nil
}

type renderSpec struct {
	Video, Music, Out string
	Duration          float64
	HasAudio          bool   // source video has an audio stream
	Overlay           string // transparent PNG with the burned text; empty = no burn
	MusicVolume       float64
}

// ffmpegArgs is pure: it builds the one ffmpeg command line for a slot.
// Inputs: 0 video, 1 music, 2 text PNG (only when Overlay is set).
func ffmpegArgs(s renderSpec) []string {
	v := "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1[v]"
	in := []string{"-i", s.Video, "-stream_loop", "-1", "-i", s.Music}
	if s.Overlay != "" {
		v = strings.TrimSuffix(v, "[v]") + "[base];" +
			"[2:v]format=rgba,split[t][s];[s]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.6,boxblur=6[sh];" +
			"[base][sh]overlay=x=(W-w)/2+3:y=(H-h)*0.72+3[b2];[b2][t]overlay=x=(W-w)/2:y=(H-h)*0.72[v]"
		in = append(in, "-i", s.Overlay)
	}
	a := "[1:a]anull[a]"
	if s.HasAudio { // the video's own sound stays at full volume, music under it
		a = "[1:a]volume=" + strconv.FormatFloat(s.MusicVolume, 'f', -1, 64) + "[m];[0:a][m]amix=inputs=2:duration=first:normalize=0[a]"
	}
	t := min(s.Duration, maxOutSeconds)
	args := append([]string{"-y", "-hide_banner", "-loglevel", "error"}, in...)
	return append(args,
		"-filter_complex", v+";"+a, "-map", "[v]", "-map", "[a]",
		"-t", strconv.FormatFloat(t, 'f', 3, 64), "-shortest",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-rc-lookahead", "10", "-threads", "2", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "128k", "-fpsmax", "60", "-movflags", "+faststart", s.Out)
}

// burnText cleans text for pango-view: control characters except \n dropped, at most 6 lines,
// at most 150 runes (cut at the last space so an emoji sequence is not split).
func burnText(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' {
			return -1
		}
		return r
	}, s)
	if lines := strings.Split(strings.TrimSpace(s), "\n"); len(lines) > 6 {
		s = strings.Join(lines[:6], "\n")
	}
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > 150 {
		cut := string(r[:150])
		if i := strings.LastIndexAny(cut, " \n"); i > 0 {
			cut = cut[:i]
		}
		s = strings.TrimSpace(cut)
	}
	return s
}

// pangoArgs is pure: it builds the pango-view command line that draws text to a transparent PNG.
// Emoji come out in colour through fontconfig fallback (fonts-noto-color-emoji).
func pangoArgs(text, out, family string) []string {
	return []string{"-q", "-o", out, "--background=transparent", "--foreground=white",
		"--font=" + family + " 48", "--width=960", "--wrap=word-char", "--align=center",
		"--margin=20", "--pixels", "--dpi=72", "--text=" + text}
}

// runCmd runs an external tool (ffmpeg, pango-view) and keeps the tail of its output on failure.
func runCmd(ctx context.Context, name string, args []string) error {
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if len(msg) > 1500 {
			msg = msg[len(msg)-1500:]
		}
		return fmt.Errorf("%s: %w: %s", filepath.Base(name), err, msg)
	}
	return nil
}
