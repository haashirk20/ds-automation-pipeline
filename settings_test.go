package main

import (
	"strings"
	"testing"
)

const goodSettings = `# comment
times = 09:00, 18:00, 18:00   # two at 18
timezone = America/Toronto
platforms = youtube, tiktok
caption =                     # pinned
hashtags = #shorts #fyp   # tags
burn_caption = no
music_volume = 0.4
youtube_privacy = unlisted
paused = no
`

func TestParseSettingsOK(t *testing.T) {
	s, err := parseSettings(goodSettings)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(s.Times, ",") != "09:00,18:00,18:00" || s.Loc.String() != "America/Toronto" ||
		strings.Join(s.Platforms, ",") != "youtube,tiktok" || s.Caption != "" ||
		s.Hashtags != "#shorts #fyp" || s.BurnCaption || s.MusicVolume != 0.4 ||
		s.YouTubePrivacy != "unlisted" || s.Paused {
		t.Fatalf("unexpected: %+v", s)
	}
}

func TestParseSettingsDefaultsDocParses(t *testing.T) {
	if _, err := parseSettings(defaultSettings); err != nil {
		t.Fatal(err)
	}
}

func TestParseSettingsErrors(t *testing.T) {
	for name, in := range map[string]string{
		"missing times":  "timezone = UTC",
		"missing tz":     "times = 09:00",
		"unknown key":    "times = 09:00\nfoo = 1",
		"bad time":       "times = 9:00",
		"bad time 25":    "times = 25:00",
		"bad tz":         "times = 09:00\ntimezone = Mars/Base",
		"bad platform":   "times = 09:00\nplatforms = youtube, myspace",
		"bad bool":       "times = 09:00\npaused = maybe",
		"volume range":   "times = 09:00\nmusic_volume = 1.5",
		"bad privacy":    "times = 09:00\nyoutube_privacy = secret",
		"no equals":      "times = 09:00\njunk",
		"duplicate key":  "times = 09:00\ntimes = 10:00",
		"volume not num": "times = 09:00\nmusic_volume = loud",
	} {
		if _, err := parseSettings(in); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}

func TestParseCaptions(t *testing.T) {
	got := parseCaptions("# c\n\nhello\\nworld\n  two  \n")
	if len(got) != 2 || got[0] != "hello\nworld" || got[1] != "two" {
		t.Fatalf("%q", got)
	}
}
