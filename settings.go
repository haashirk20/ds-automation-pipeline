package main

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

type Settings struct {
	Times          []string // "HH:MM", order kept, duplicates allowed
	Loc            *time.Location
	Platforms      []string
	Caption        string
	Hashtags       string
	BurnCaption    bool
	MusicVolume    float64
	YouTubePrivacy string
	Paused         bool
}

var allPlatforms = []string{"youtube", "instagram", "facebook", "tiktok"}

// an inline comment is a '#' standing alone, so "#shorts" in a value is kept
var inlineComment = regexp.MustCompile(`(^|\s)#(\s|$)`)

// parseSettings is strict: any problem is an error and the caller must post nothing.
func parseSettings(text string) (Settings, error) {
	s := Settings{
		Loc: time.UTC, Platforms: slices.Clone(allPlatforms), BurnCaption: true,
		MusicVolume: 0.25, YouTubePrivacy: "public",
	}
	seen := map[string]bool{}
	for i, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		if !ok {
			return s, fmt.Errorf("settings line %d: expected key = value", i+1)
		}
		if loc := inlineComment.FindStringIndex(val); loc != nil {
			val = val[:loc[0]]
		}
		val = strings.TrimSpace(val)
		if seen[key] {
			return s, fmt.Errorf("settings line %d: duplicate key %q", i+1, key)
		}
		seen[key] = true
		var err error
		switch key {
		case "times":
			s.Times, err = parseTimes(val)
		case "timezone":
			s.Loc, err = time.LoadLocation(val)
			if val == "" || val == "Local" {
				err = fmt.Errorf("bad timezone %q", val)
			}
		case "platforms":
			s.Platforms, err = parsePlatforms(val)
		case "caption":
			s.Caption = val
		case "hashtags":
			s.Hashtags = val
		case "burn_caption":
			s.BurnCaption, err = parseBool(val)
		case "music_volume":
			s.MusicVolume, err = strconv.ParseFloat(val, 64)
			if err == nil && (s.MusicVolume < 0 || s.MusicVolume > 1) {
				err = fmt.Errorf("must be 0..1")
			}
		case "youtube_privacy":
			s.YouTubePrivacy = val
			if !slices.Contains([]string{"public", "unlisted", "private"}, val) {
				err = fmt.Errorf("must be public, unlisted or private")
			}
		case "paused":
			s.Paused, err = parseBool(val)
		default:
			err = fmt.Errorf("unknown key")
		}
		if err != nil {
			return s, fmt.Errorf("settings line %d (%s): %w", i+1, key, err)
		}
	}
	if !seen["times"] || !seen["timezone"] {
		return s, fmt.Errorf("settings: times and timezone are required")
	}
	return s, nil
}

func splitList(v string) []string {
	var out []string
	for _, f := range strings.Split(v, ",") {
		out = append(out, strings.TrimSpace(f))
	}
	return out
}

func parseTimes(v string) ([]string, error) {
	var out []string
	for _, t := range splitList(v) {
		if _, err := time.Parse("15:04", t); err != nil || len(t) != 5 {
			return nil, fmt.Errorf("bad time %q, want HH:MM", t)
		}
		out = append(out, t)
	}
	return out, nil
}

func parsePlatforms(v string) ([]string, error) {
	var out []string
	for _, p := range splitList(v) {
		if !slices.Contains(allPlatforms, p) {
			return nil, fmt.Errorf("unknown platform %q", p)
		}
		if !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	return out, nil
}

func parseBool(v string) (bool, error) {
	switch strings.ToLower(v) {
	case "yes", "true":
		return true, nil
	case "no", "false":
		return false, nil
	}
	return false, fmt.Errorf("want yes or no, got %q", v)
}
