package main

import (
	"strings"
	"testing"
)

const goodSettings = `# comment
times = 09:00, 18:00, 18:00   # two at 18
timezone = America/Toronto
platforms = youtube, tiktok
burn_text =                   # pinned
default_caption = Shop now    # fallback
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
		strings.Join(s.Platforms, ",") != "youtube,tiktok" || s.BurnText != "" || s.DefaultCaption != "Shop now" ||
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
		"missing times":   "timezone = UTC",
		"missing tz":      "times = 09:00",
		"unknown key":     "times = 09:00\nfoo = 1",
		"bad time":        "times = 9:00",
		"bad time 25":     "times = 25:00",
		"bad tz":          "times = 09:00\ntimezone = Mars/Base",
		"bad platform":    "times = 09:00\nplatforms = youtube, myspace",
		"bad bool":        "times = 09:00\npaused = maybe",
		"volume range":    "times = 09:00\nmusic_volume = 1.5",
		"bad privacy":     "times = 09:00\nyoutube_privacy = secret",
		"no equals":       "times = 09:00\njunk",
		"duplicate key":   "times = 09:00\ntimes = 10:00",
		"old caption key": "times = 09:00\ncaption = hi",
		"volume not num":  "times = 09:00\nmusic_volume = loud",
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

func TestParseSettingsOldCaptionKey(t *testing.T) {
	_, err := parseSettings("times = 09:00\ntimezone = UTC\ncaption = hi")
	if err == nil || !strings.Contains(err.Error(), "caption was split: use burn_text for on-video text; post captions now live in the products doc") {
		t.Fatalf("%v", err)
	}
}

func TestParseProducts(t *testing.T) {
	got, err := parseProducts(`# top comment

[Velvet Tarot Deck]

# a note
Hand-gilded tarot deck ✨ Link in bio #tarot
second line

[ Candle ]
#only a hashtag line
[Empty]
`)
	if err != nil {
		t.Fatal(err)
	}
	if got["Velvet Tarot Deck"] != "Hand-gilded tarot deck ✨ Link in bio #tarot\nsecond line" ||
		got["Candle"] != "#only a hashtag line" || got["Empty"] != "" || len(got) != 3 {
		t.Fatalf("%q", got)
	}
	if _, err := parseProducts("[A]\nx\n[B]\ny\n[A]\nz"); err == nil {
		t.Error("duplicate header must fail")
	}
	if _, err := parseProducts("stray\n[A]\nx"); err == nil {
		t.Error("text before first header must fail")
	}
	if got, err := parseProducts(defaultProducts); err != nil || len(got) != 0 {
		t.Errorf("default products doc: %v %v", got, err)
	}
}
