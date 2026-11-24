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
	folders := map[string]bool{"Velvet Tarot Deck": true, "Candle": true, "Empty": true}
	got, warns, err := parseProducts(`# top comment

[Velvet Tarot Deck]

# a note
Hand-gilded tarot deck ✨ Link in bio #tarot
#1 seller 🔥
[nope]

[ Candle ]
#only a hashtag line
[Empty]
`, folders)
	if err != nil {
		t.Fatal(err)
	}
	if got["Velvet Tarot Deck"] != "Hand-gilded tarot deck ✨ Link in bio #tarot\n#1 seller 🔥\n[nope]" ||
		got["Candle"] != "#only a hashtag line" || got["Empty"] != "" || len(got) != 3 {
		t.Fatalf("%q", got)
	}
	if len(warns) != 1 || !strings.Contains(warns[0], "[nope] does not match a product folder") {
		t.Fatalf("warns %v", warns)
	}
	if _, _, err := parseProducts("[Candle]\nx\n[Empty]\ny\n[Candle]\nz", folders); err == nil {
		t.Error("duplicate header must fail")
	}
	if got, _, err := parseProducts("stray\n[Candle]\nx", folders); err != nil || len(got) != 1 {
		t.Errorf("stray leading text is ignored: %v %v", got, err)
	}
	if _, w, err := parseProducts("[typo]\n[Candle]\nx", folders); err != nil || len(w) != 1 {
		t.Errorf("unknown header before first: %v %v", w, err)
	}
	if got, _, err := parseProducts(defaultProducts, folders); err != nil || len(got) != 0 {
		t.Errorf("default products doc: %v %v", got, err)
	}
}

func TestParseCaptionsHashtagLinesKept(t *testing.T) {
	got := parseCaptions("# note\n#\n#1 seller 🔥\n#tarot")
	if len(got) != 2 || got[0] != "#1 seller 🔥" || got[1] != "#tarot" {
		t.Fatalf("%q", got)
	}
}
