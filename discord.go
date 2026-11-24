package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"
)

// discordMaxFile is Discord's attachment limit for a server without boosts.
const discordMaxFile = 10 << 20

// result is one platform's outcome for a slot.
type result struct {
	platform, id string
	err          error
}

func isDiscordWebhook(u string) bool {
	return strings.HasPrefix(u, "https://discord.com/api/webhooks/") || strings.HasPrefix(u, "https://discordapp.com/api/webhooks/")
}

// discordText is pure: the message for one slot, under Discord's 2000-character limit.
func discordText(slotID, product, burn, text string, dryRun bool, res []result, attached bool) string {
	var b strings.Builder
	title := "Posted"
	if dryRun {
		title = "Dry run (nothing posted)"
	}
	if product == "" {
		product = "(loose video)"
	}
	fmt.Fprintf(&b, "**%s** · %s · %s\n", title, product, slotID)
	for _, r := range res {
		switch {
		case r.err != nil:
			fmt.Fprintf(&b, "❌ %s: %s\n", r.platform, cutRunes(r.err.Error(), 200))
		case r.id == "":
			fmt.Fprintf(&b, "⏭️ %s\n", r.platform)
		default:
			fmt.Fprintf(&b, "✅ %s: %s\n", r.platform, r.id)
		}
	}
	if burn != "" {
		fmt.Fprintf(&b, "On video: %s\n", strings.ReplaceAll(burn, "\n", " "))
	}
	if !attached {
		b.WriteString("(video over 10 MB, not attached)\n")
	}
	fmt.Fprintf(&b, "Caption:\n%s", text)
	return cutRunes(b.String(), 1900)
}

// notifyDiscord posts the slot summary, with the video attached when it fits, to the webhook.
// It never fails the tick. Errors never include the URL, whose path holds the webhook token.
func (t *ticker) notifyDiscord(ctx context.Context, sl slot, post Post, res []result) {
	if t.discord == "" {
		return
	}
	f, size, err := openFile(post.File)
	if err == nil {
		defer f.Close()
	}
	attach := err == nil && size <= discordMaxFile
	payload, _ := json.Marshal(map[string]any{
		"content":          discordText(sl.ID, post.Product, post.Burn, post.Text, t.dryRun, res, attach),
		"allowed_mentions": map[string]any{"parse": []string{}}, // a caption can never ping @everyone
	})

	// multipart built around the file so the video is streamed, not read into memory
	var head bytes.Buffer
	mw := multipart.NewWriter(&head)
	mw.WriteField("payload_json", string(payload))
	var body io.Reader
	var length int64
	if attach {
		if _, err := mw.CreateFormFile("files[0]", "video.mp4"); err != nil {
			return
		}
		prefix := bytes.Clone(head.Bytes())
		head.Reset()
		mw.Close()
		body, length = io.MultiReader(bytes.NewReader(prefix), f, bytes.NewReader(head.Bytes())), int64(len(prefix))+size+int64(head.Len())
	} else {
		mw.Close()
		body, length = bytes.NewReader(head.Bytes()), int64(head.Len())
	}

	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", t.discord, body)
	if err != nil {
		t.log.Warn("discord webhook: bad request")
		return
	}
	req.ContentLength = length
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := t.hc.Do(req)
	if err != nil {
		reason := "network error"
		if errors.Is(err, context.DeadlineExceeded) {
			reason = "timeout"
		}
		t.log.Warn("discord webhook failed", "slot", sl.ID, "err", reason)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		t.log.Warn("discord webhook failed", "slot", sl.ID, "status", resp.StatusCode, "body", cutRunes(strings.TrimSpace(string(b)), 200))
		return
	}
	t.log.Info("discord notified", "slot", sl.ID, "video_attached", attach)
}
