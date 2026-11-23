package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
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
	KeepAudio         bool // video name has _keepaudio
	HasAudio          bool // source video has an audio stream
	Burn              bool
	TextFile, Font    string
	MusicVolume       float64
}

// ffmpegArgs is pure: it builds the one ffmpeg command line for a slot.
func ffmpegArgs(s renderSpec) ([]string, error) {
	if s.Burn && (strings.Contains(s.Font, "'") || strings.Contains(s.TextFile, "'")) {
		return nil, fmt.Errorf("font or caption file path contains a quote")
	}
	v := "[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1"
	if s.Burn {
		v += ",drawtext=fontfile='" + escapeFilterPath(s.Font) + "':textfile='" + escapeFilterPath(s.TextFile) +
			"':expansion=none:fontcolor=white:borderw=4:bordercolor=black:fontsize=56:line_spacing=12:x=(w-text_w)/2:y=(h-text_h)*0.7"
	}
	v += "[v]"
	a := "[1:a]anull[a]"
	if s.KeepAudio && s.HasAudio {
		a = "[1:a]volume=" + strconv.FormatFloat(s.MusicVolume, 'f', -1, 64) + "[m];[0:a][m]amix=inputs=2:duration=first:normalize=0[a]"
	}
	t := min(s.Duration, maxOutSeconds)
	return []string{"-y", "-hide_banner", "-loglevel", "error",
		"-i", s.Video, "-stream_loop", "-1", "-i", s.Music,
		"-filter_complex", v + ";" + a, "-map", "[v]", "-map", "[a]",
		"-t", strconv.FormatFloat(t, 'f', 3, 64), "-shortest",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-rc-lookahead", "10", "-threads", "2", "-pix_fmt", "yuv420p",
		"-c:a", "aac", "-b:a", "128k", "-fpsmax", "60", "-movflags", "+faststart", s.Out}, nil
}

// escapeFilterPath escapes a path for use inside single quotes in a filter graph.
// Paths containing a quote are refused earlier, in ffmpegArgs.
func escapeFilterPath(p string) string {
	return strings.NewReplacer(`\`, `\\`, `:`, `\:`).Replace(p)
}

// capLines keeps at most n lines; the last kept line ends with an ellipsis if lines were dropped.
func capLines(s string, n int) string {
	lines := strings.Split(s, "\n")
	if len(lines) <= n {
		return s
	}
	lines = lines[:n]
	last := []rune(lines[n-1])
	if len(last) > 23 {
		last = last[:23]
	}
	lines[n-1] = string(last) + "…"
	return strings.Join(lines, "\n")
}

// stripSymbols removes emoji and other symbol runes the font cannot draw.
func stripSymbols(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r == '\n':
			b.WriteRune(r)
		case r > 0xFFFF, unicode.Is(unicode.So, r), unicode.Is(unicode.Cf, r), unicode.IsControl(r),
			r >= 0xFE00 && r <= 0xFE0F:
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// wrapCaption breaks text into lines of at most width runes; \n in the input is kept.
func wrapCaption(s string, width int) string {
	var lines []string
	for _, para := range strings.Split(s, "\n") {
		line := ""
		flush := func() {
			if line != "" {
				lines = append(lines, line)
				line = ""
			}
		}
		for _, w := range strings.Fields(para) {
			r := []rune(w)
			for len(r) > width {
				flush()
				lines = append(lines, string(r[:width]))
				r = r[width:]
			}
			w = string(r)
			switch {
			case line == "":
				line = w
			case len([]rune(line))+1+len(r) <= width:
				line += " " + w
			default:
				flush()
				line = w
			}
		}
		flush()
	}
	return strings.Join(lines, "\n")
}

func runFFmpeg(ctx context.Context, ffmpeg string, args []string) error {
	out, err := exec.CommandContext(ctx, ffmpeg, args...).CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		if len(msg) > 1500 {
			msg = msg[len(msg)-1500:]
		}
		return fmt.Errorf("ffmpeg: %w: %s", err, msg)
	}
	return nil
}
