package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

type ticker struct {
	d       *drive
	root    string
	pubs    map[string]Publisher // only platforms with credentials present
	font    string
	dryRun  bool
	log     *slog.Logger
	ffmpeg  string
	ffprobe string

	mu    sync.Mutex
	ids   map[string]string    // resolved Drive IDs, dropped when Drive answers 404
	retry map[string]time.Time // slot ID -> do not try again before this time
}

const retryDelay = 20 * time.Minute

// resolveIDs returns the Drive IDs of the named root items, asking Drive only for names not cached.
func (t *ticker) resolveIDs(ctx context.Context, names ...string) (map[string]string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := map[string]string{}
	var missing []string
	for _, n := range names {
		if id := t.ids[n]; id != "" {
			out[n] = id
		} else {
			missing = append(missing, n)
		}
	}
	if len(missing) > 0 {
		got, err := t.d.resolve(ctx, t.root, missing...)
		if err != nil {
			return nil, err
		}
		if t.ids == nil {
			t.ids = map[string]string{}
		}
		for k, v := range got {
			t.ids[k], out[k] = v, v
		}
	}
	return out, nil
}

// fix drops the ID cache when err is a Drive 404 (item deleted or replaced) and returns err.
func (t *ticker) fix(err error) error {
	if err != nil && strings.Contains(err.Error(), "HTTP 404") {
		t.mu.Lock()
		t.ids = nil
		t.mu.Unlock()
	}
	return err
}

type loaded struct {
	ids map[string]string
	set Settings
	st  state
	due []slot
}

// load reads settings and, when a slot is in its window (or force), state, and works out the due slots.
// A stale cached ID is dropped and the load tried once more.
func (t *ticker) load(ctx context.Context, now time.Time, force bool) (loaded, error) {
	l, err := t.load1(ctx, now, force)
	if err != nil && strings.Contains(err.Error(), "HTTP 404") {
		t.fix(err)
		return t.load1(ctx, now, force)
	}
	return l, err
}

func (t *ticker) load1(ctx context.Context, now time.Time, force bool) (loaded, error) {
	var l loaded
	ids, err := t.resolveIDs(ctx, "settings", "state.json")
	if err != nil {
		return l, err
	}
	l.ids = ids
	text, err := t.d.exportText(ctx, ids["settings"])
	if err != nil {
		return l, err
	}
	if l.set, err = parseSettings(text); err != nil {
		return l, err
	}
	if !force && len(dueSlots(l.set, state{}, now)) == 0 { // nothing in its window, state.json is not needed
		return l, nil
	}
	b, err := t.d.media(ctx, ids["state.json"])
	if err != nil {
		return l, err
	}
	if err := json.Unmarshal(b, &l.st); err != nil {
		return l, fmt.Errorf("state.json: bad JSON")
	}
	l.due = dueSlots(l.set, l.st, now)
	return l, nil
}

func (t *ticker) isDue(ctx context.Context, now time.Time) (bool, error) {
	l, err := t.load(ctx, now, false)
	return len(l.due) > 0, err
}

// tick runs every due slot. Claim failure aborts; other failures are counted and returned at the end.
func (t *ticker) tick(ctx context.Context, now time.Time) error { return t.run(ctx, now, "") }

// run is tick plus, when manual is not empty, one extra slot with that ID (claimed like any slot).
func (t *ticker) run(ctx context.Context, now time.Time, manual string) error {
	l, err := t.load(ctx, now, manual != "")
	if err != nil {
		return err
	}
	t.mu.Lock()
	l.due = slices.DeleteFunc(l.due, func(sl slot) bool { return t.retry[sl.ID].After(now) })
	t.mu.Unlock()
	if manual != "" {
		if _, done := l.st.Claims[manual]; done {
			return fmt.Errorf("slot %q is already claimed", manual)
		}
		l.due = append(l.due, slot{ID: manual, At: now})
	}
	if len(l.due) == 0 {
		t.log.Debug("nothing due")
		return nil
	}
	rest, err := t.resolveIDs(ctx, "videos", "music", "captions")
	if err != nil {
		return err
	}
	for k, v := range rest {
		l.ids[k] = v
	}
	for _, name := range l.set.Platforms {
		if t.pubs[name] == nil {
			return fmt.Errorf("platform %s is enabled but its credentials are missing", name)
		}
	}
	failures := 0
	for _, sl := range l.due {
		post, cleanup, err := t.prepare(ctx, sl, l)
		if err != nil {
			cleanup()
			t.setRetry(sl.ID, now)
			t.log.Error("slot failed before claim, will retry in 20 min", "slot", sl.ID, "err", t.fix(err).Error())
			failures++
			continue
		}
		// the claim is written before any publish request: a crash later loses the slot, never doubles it
		if t.dryRun {
			t.setRetry(sl.ID, now)
			t.log.Info("dry run: claim skipped", "slot", sl.ID)
		} else {
			claim(&l.st, sl.ID, now)
			b, _ := json.Marshal(l.st)
			if err := t.d.update(ctx, l.ids["state.json"], b, "application/json"); err != nil {
				cleanup()
				return fmt.Errorf("claim %s: %w", sl.ID, err)
			}
		}
		failures += t.publishAll(ctx, sl, l, post)
		cleanup()
	}
	if failures > 0 {
		return fmt.Errorf("%d failure(s)", failures)
	}
	return nil
}

func (t *ticker) setRetry(id string, now time.Time) {
	t.mu.Lock()
	if t.retry == nil {
		t.retry = map[string]time.Time{}
	}
	t.retry[id] = now.Add(retryDelay)
	t.mu.Unlock()
}

func (t *ticker) publishAll(ctx context.Context, sl slot, l loaded, post Post) int {
	failures := 0
	for _, name := range l.set.Platforms {
		if t.dryRun {
			t.log.Info("dry run, publish skipped", "slot", sl.ID, "platform", name)
			continue
		}
		pctx, cancel := context.WithTimeout(ctx, 12*time.Minute)
		id, err := t.pubs[name].Publish(pctx, post)
		cancel()
		if err != nil {
			t.log.Error("publish failed", "slot", sl.ID, "platform", name, "err", err.Error())
			failures++
			continue
		}
		t.log.Info("published", "slot", sl.ID, "platform", name, "id", id)
	}
	return failures
}

// prepare picks the media and caption, renders the video and builds the Post.
// The returned cleanup removes the temp dir and must be called even when err != nil
// (it is never nil when the temp dir exists; a nil cleanup means MkdirTemp failed).
func (t *ticker) prepare(ctx context.Context, sl slot, l loaded) (Post, func(), error) {
	var post Post
	dir, err := os.MkdirTemp("", "uploader-")
	if err != nil {
		return post, func() {}, err
	}
	cleanup := func() { os.RemoveAll(dir) }

	caption := l.set.Caption
	if caption == "" {
		text, err := t.d.exportText(ctx, l.ids["captions"])
		if err != nil {
			return post, cleanup, err
		}
		cs := parseCaptions(text)
		if len(cs) == 0 {
			return post, cleanup, fmt.Errorf("no caption: settings caption is empty and captions doc has no lines")
		}
		caption = cs[rand.IntN(len(cs))]
	} else {
		caption = strings.ReplaceAll(caption, `\n`, "\n")
	}

	videos, err := t.d.list(ctx, l.ids["videos"], "video/")
	if err != nil {
		return post, cleanup, err
	}
	musics, err := t.d.list(ctx, l.ids["music"], "audio/")
	if err != nil {
		return post, cleanup, err
	}
	if len(videos) == 0 || len(musics) == 0 {
		return post, cleanup, fmt.Errorf("need at least one video and one music file (have %d, %d)", len(videos), len(musics))
	}

	// pick a video of at least 3 s, trying up to 5 different files
	rand.Shuffle(len(videos), func(i, j int) { videos[i], videos[j] = videos[j], videos[i] })
	vpath := filepath.Join(dir, "video")
	var pr probeResult
	var vname string
	picked := false
	for i := 0; i < len(videos) && i < 5 && !picked; i++ {
		v := videos[i]
		if err := t.d.download(ctx, v.ID, vpath); err != nil {
			t.log.Warn("video download failed, trying another", "slot", sl.ID, "file", v.Name, "err", err.Error())
			continue
		}
		if pr, err = probe(ctx, t.ffprobe, vpath); err != nil {
			t.log.Warn("video probe failed, trying another", "slot", sl.ID, "file", v.Name, "err", err.Error())
			continue
		}
		if pr.Duration < 3 {
			t.log.Warn("video too short, trying another", "slot", sl.ID, "file", v.Name)
			continue
		}
		vname, picked = v.Name, true
	}
	if !picked {
		return post, cleanup, fmt.Errorf("no usable video after up to 5 tries")
	}
	m := musics[rand.IntN(len(musics))]
	mpath := filepath.Join(dir, "music")
	if err := t.d.download(ctx, m.ID, mpath); err != nil {
		return post, cleanup, err
	}

	burned := capLines(wrapCaption(strings.TrimSpace(stripSymbols(caption)), 24), 5)
	tfile := filepath.Join(dir, "caption.txt")
	if err := os.WriteFile(tfile, []byte(burned), 0o600); err != nil {
		return post, cleanup, err
	}
	out := filepath.Join(dir, "out.mp4")
	args, err := ffmpegArgs(renderSpec{
		Video: vpath, Music: mpath, Out: out, Duration: pr.Duration,
		KeepAudio: strings.Contains(vname, "_keepaudio"), HasAudio: pr.HasAudio,
		Burn: l.set.BurnCaption && burned != "", TextFile: tfile, Font: t.font, MusicVolume: l.set.MusicVolume,
	})
	if err != nil {
		return post, cleanup, err
	}
	if err := runFFmpeg(ctx, t.ffmpeg, args); err != nil {
		return post, cleanup, err
	}
	post = buildPost(caption, l.set, sl.ID, out)
	return post, cleanup, nil
}

func buildPost(caption string, set Settings, slotID, file string) Post {
	tags := limitHashtags(set.Hashtags, 30)
	text := caption
	if tags != "" {
		text += "\n\n" + tags
	}
	first, _, _ := strings.Cut(caption, "\n")
	title := strings.TrimSpace(first + " " + tags)
	title = strings.NewReplacer("<", "", ">", "").Replace(title)
	return Post{File: file, Text: cutRunes(text, 2200), Title: cutRunes(title, 100), SlotID: slotID, Privacy: set.YouTubePrivacy}
}

// limitHashtags keeps at most n whitespace-separated words starting with '#'.
func limitHashtags(s string, n int) string {
	var keep []string
	for _, w := range strings.Fields(s) {
		if strings.HasPrefix(w, "#") && len(keep) >= n {
			continue
		}
		keep = append(keep, w)
	}
	return strings.Join(keep, " ")
}

func cutRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
