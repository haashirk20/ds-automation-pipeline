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
	"time"
)

type ticker struct {
	d       *drive
	root    string
	pubs    map[string]Publisher // only platforms with credentials present
	font    string               // pango font family
	pango   string
	dryRun  bool
	log     *slog.Logger
	ffmpeg  string
	ffprobe string
}

type loaded struct {
	ids     map[string]string
	set     Settings
	st      state
	due     []slot
	prod    map[string]string // product name -> post caption
	folders map[string]bool   // product folders in videos/
	cands   []cand            // products that have videos
	musics  []driveFile
}

// load reads settings and state and works out the due slots. It is all `due` needs.
func (t *ticker) load(ctx context.Context, now time.Time) (loaded, error) {
	var l loaded
	ids, err := t.d.resolve(ctx, t.root, "settings", "state.json")
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
	l, err := t.load(ctx, now)
	return len(l.due) > 0, err
}

// tick runs every due slot, plus one extra slot with ID manual when manual is not empty (claimed like any slot).
// Claim failure aborts; other failures are counted and returned at the end.
func (t *ticker) tick(ctx context.Context, now time.Time, manual string) error {
	l, err := t.load(ctx, now)
	if err != nil {
		return err
	}
	if manual != "" {
		if _, done := l.st.Claims[manual]; done {
			return fmt.Errorf("slot %q is already claimed", manual)
		}
		l.due = append(l.due, slot{ID: manual, At: now})
	}
	if len(l.due) == 0 {
		t.log.Info("nothing due")
		return nil
	}
	rest, err := t.d.resolve(ctx, t.root, "videos", "music", "captions", "products")
	if err != nil {
		return fmt.Errorf("%w (products doc missing? run uploader init)", err)
	}
	for k, v := range rest {
		l.ids[k] = v
	}
	// list the media once per tick; every slot picks from this
	folders, err := t.d.listFolders(ctx, l.ids["videos"])
	if err != nil {
		return err
	}
	l.folders = map[string]bool{}
	for _, f := range folders {
		name := strings.TrimSpace(f.Name)
		l.folders[name] = true
		vs, err := t.d.list(ctx, f.ID, "video/")
		if err != nil {
			return err
		}
		if len(vs) > 0 {
			l.cands = append(l.cands, cand{name, vs})
		}
	}
	loose, err := t.d.list(ctx, l.ids["videos"], "video/")
	if err != nil {
		return err
	}
	if len(loose) > 0 { // loose videos in videos/ are the product ""
		l.cands = append(l.cands, cand{"", loose})
	}
	if l.musics, err = t.d.list(ctx, l.ids["music"], "audio/"); err != nil {
		return err
	}
	ptext, err := t.d.exportText(ctx, l.ids["products"])
	if err != nil {
		return err
	}
	var warns []string
	if l.prod, warns, err = parseProducts(ptext, l.folders); err != nil {
		return err
	}
	for _, w := range warns {
		t.log.Warn(w)
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
			t.log.Error("slot failed before claim, will retry next run", "slot", sl.ID, "err", err.Error())
			failures++
			continue
		}
		// the claim is written before any publish request: a crash later loses the slot, never doubles it
		if t.dryRun {
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

	cands, musics := l.cands, l.musics
	if len(cands) == 0 || len(musics) == 0 {
		return post, cleanup, fmt.Errorf("need at least one video and one music file (have %d products with videos, %d music)", len(cands), len(musics))
	}

	// pick a random product, then a random video; if it is unusable (under 3 s, bad file) pick again,
	// up to 5 tries. A file already tried is never picked twice.
	vpath := filepath.Join(dir, "video")
	var pr probeResult
	var product, vname string
	picked := false
	for i := 0; i < 5 && len(cands) > 0 && !picked; i++ {
		var v driveFile
		product, v, cands = pick(cands, rand.IntN)
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

	caption := l.prod[product]
	if caption == "" {
		caption = l.set.DefaultCaption
		t.log.Warn("no caption for product, using default_caption", "slot", sl.ID, "product", product)
	}

	spec := renderSpec{Video: vpath, Music: mpath, Out: filepath.Join(dir, "out.mp4"), Duration: pr.Duration,
		KeepAudio: strings.Contains(vname, "_keepaudio"), HasAudio: pr.HasAudio, MusicVolume: l.set.MusicVolume}
	if l.set.BurnCaption {
		text := l.set.BurnText
		if text == "" {
			ctext, err := t.d.exportText(ctx, l.ids["captions"])
			if err != nil {
				return post, cleanup, err
			}
			cs := parseCaptions(ctext)
			if len(cs) == 0 {
				return post, cleanup, fmt.Errorf("no burn text: settings burn_text is empty and captions doc has no lines")
			}
			text = cs[rand.IntN(len(cs))]
		}
		if text = burnText(strings.ReplaceAll(text, `\n`, "\n")); text != "" {
			spec.Overlay = filepath.Join(dir, "text.png")
			if err := runCmd(ctx, t.pango, pangoArgs(text, spec.Overlay, t.font)); err != nil {
				return post, cleanup, err
			}
		}
	}
	if err := runCmd(ctx, t.ffmpeg, ffmpegArgs(spec)); err != nil {
		return post, cleanup, err
	}
	post = buildPost(caption, product, l.set, sl.ID, spec.Out)
	return post, cleanup, nil
}

// cand is one product and its not-yet-tried videos.
type cand struct {
	product string
	vids    []driveFile
}

// pick chooses a random product, then a random video of it, and returns the rest
// without that video (a product with no videos left is dropped).
func pick(cs []cand, intn func(int) int) (string, driveFile, []cand) {
	i := intn(len(cs))
	j := intn(len(cs[i].vids))
	v := cs[i].vids[j]
	rest := slices.Clone(cs)
	rest[i].vids = slices.Delete(slices.Clone(cs[i].vids), j, j+1)
	if len(rest[i].vids) == 0 {
		rest = slices.Delete(rest, i, i+1)
	}
	return cs[i].product, v, rest
}

func buildPost(caption, product string, set Settings, slotID, file string) Post {
	tags := limitHashtags(set.Hashtags, 30)
	text := strings.TrimSpace(caption + "\n\n" + tags)
	first, _, _ := strings.Cut(caption, "\n")
	title := strings.TrimSpace(strings.NewReplacer("<", "", ">", "").Replace(first + " " + tags))
	if title == "" {
		title = product
	}
	if title == "" {
		title = "New video"
	}
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
