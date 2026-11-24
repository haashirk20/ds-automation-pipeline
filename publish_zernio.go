package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"time"
)

// zernio is one API client shared by the YouTube and TikTok publishers.
type zernio struct {
	key, base          string
	hc                 *http.Client
	pollEvery, pollFor time.Duration
	// Caches live for one slot only, so a long-running process never reuses a stale account or URL.
	slot     string
	accounts []zAccount // fetched once per slot
	url      string     // presigned publicUrl of urlFile
	urlFile  string     // YouTube and TikTok get different files, so the URL is reused only for the same file
}

type zAccount struct {
	ID       string `json:"_id"`
	Platform string `json:"platform"`
	Active   *bool  `json:"isActive"`
}

func newZernio(apiKey string, hc *http.Client) *zernio {
	return &zernio{key: apiKey, base: "https://zernio.com/api/v1", hc: hc, pollEvery: 10 * time.Second, pollFor: 5 * time.Minute}
}

type zPublisher struct {
	z        *zernio
	platform string
}

func (z *zernio) youtube() Publisher { return &zPublisher{z, "youtube"} }
func (z *zernio) tiktok() Publisher  { return &zPublisher{z, "tiktok"} }

func (t *zPublisher) Name() string { return t.platform }

type zPost struct {
	ID        string `json:"_id"`
	Status    string `json:"status"`
	Platforms []struct {
		Platform     string `json:"platform"`
		Status       string `json:"status"`
		ErrorMessage string `json:"errorMessage"`
	} `json:"platforms"`
}

func (p zPost) state(platform string) (status, errMsg string) {
	for _, e := range p.Platforms {
		if e.Platform == platform {
			return e.Status, e.ErrorMessage
		}
	}
	return p.Status, ""
}

// z calls the Zernio API and returns status and body without judging the status.
func (t *zernio) z(ctx context.Context, method, path string, extra map[string]string, in any) (int, []byte, error) {
	h := map[string]string{"Authorization": "Bearer " + t.key}
	for k, v := range extra {
		h[k] = v
	}
	var body io.Reader
	var size int64 = -1
	if in != nil {
		b, _ := json.Marshal(in)
		body, size = bytes.NewReader(b), int64(len(b))
		h["Content-Type"] = "application/json"
	}
	st, b, _, err := call(ctx, t.hc, apiTimeout, method, t.base+path, h, body, size)
	return st, b, err
}

// zOK is z plus an error for any non-2xx status, decoding the JSON answer into out.
func (t *zernio) zOK(ctx context.Context, method, path string, extra map[string]string, in, out any) error {
	st, b, err := t.z(ctx, method, path, extra, in)
	if err != nil {
		return err
	}
	if st < 200 || st > 299 {
		return apiError(method, t.base+path, st, b)
	}
	if err := json.Unmarshal(b, out); err != nil {
		return fmt.Errorf("%s %s: bad JSON response", method, path)
	}
	return nil
}

// account returns the first active account for a platform; the list is fetched once per slot.
func (t *zernio) account(ctx context.Context, platform string) (string, error) {
	if t.accounts == nil {
		var accs struct {
			Accounts []zAccount `json:"accounts"`
		}
		if err := t.zOK(ctx, "GET", "/accounts", nil, nil, &accs); err != nil {
			return "", err
		}
		t.accounts = accs.Accounts
	}
	for _, a := range t.accounts {
		if a.Platform == platform && (a.Active == nil || *a.Active) {
			return a.ID, nil
		}
	}
	return "", fmt.Errorf("%s: no active %s account", platform, platform)
}

// mediaURL presigns and uploads the slot's video once; the slot's other platform reuses the URL.
func (t *zernio) mediaURL(ctx context.Context, path string) (string, error) {
	if t.url != "" && t.urlFile == path {
		return t.url, nil
	}
	f, size, err := openFile(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	var pre struct {
		UploadURL string `json:"uploadUrl"`
		PublicURL string `json:"publicUrl"`
	}
	if err := t.zOK(ctx, "POST", "/media/presign", nil, map[string]any{"filename": filepath.Base(path), "contentType": "video/mp4", "size": size}, &pre); err != nil {
		return "", err
	}
	if pre.UploadURL == "" || pre.PublicURL == "" {
		return "", errors.New("zernio: presign returned no URL")
	}
	// No Authorization header: the presigned URL is a third-party host.
	if _, err := callOK(ctx, t.hc, uploadTimeout, "PUT", pre.UploadURL, map[string]string{"Content-Type": "video/mp4"}, f, size); err != nil {
		return "", err
	}
	t.url, t.urlFile = pre.PublicURL, path
	return pre.PublicURL, nil
}

func (t *zPublisher) Publish(ctx context.Context, p Post) (string, error) {
	z, name := t.z, t.platform
	if z.slot != p.SlotID {
		z.slot, z.accounts, z.url, z.urlFile = p.SlotID, nil, "", ""
	}
	acct, err := z.account(ctx, name)
	if err != nil {
		return "", err
	}
	content := p.Text
	entry := map[string]any{"platform": name, "accountId": acct}
	body := map[string]any{"publishNow": true, "platforms": []any{entry}}

	if name == "youtube" {
		content = strings.NewReplacer("<", "", ">", "").Replace(content)
		entry["platformSpecificData"] = map[string]any{"title": p.Title, "visibility": p.Privacy, "madeForKids": false}
	} else {
		var info struct {
			PrivacyLevels []struct {
				Value string `json:"value"`
			} `json:"privacyLevels"`
			PostingLimits struct {
				InteractionSettings map[string]struct {
					Enabled *bool `json:"enabled"`
				} `json:"interactionSettings"`
			} `json:"postingLimits"`
		}
		if err := z.zOK(ctx, "GET", "/accounts/"+url.PathEscape(acct)+"/tiktok/creator-info?mediaType=video", nil, nil, &info); err != nil {
			return "", err
		}
		public := false
		for _, l := range info.PrivacyLevels {
			public = public || l.Value == "PUBLIC_TO_EVERYONE"
		}
		if !public {
			return "", errors.New("tiktok: account does not offer PUBLIC_TO_EVERYONE")
		}
		allow := func(k string) bool { e := info.PostingLimits.InteractionSettings[k].Enabled; return e == nil || *e }
		body["tiktokSettings"] = map[string]any{
			"privacy_level": "PUBLIC_TO_EVERYONE", "allow_comment": allow("allow_comment"), "allow_duet": allow("allow_duet"),
			"allow_stitch": allow("allow_stitch"), "content_preview_confirmed": true, "express_consent_given": true,
			"video_made_with_ai": false, "commercialContentType": "brand_organic",
		}
	}

	pub, err := z.mediaURL(ctx, p.File)
	if err != nil {
		return "", err
	}
	body["content"] = content
	body["mediaItems"] = []any{map[string]any{"type": "video", "url": pub}}

	st, b, err := z.z(ctx, "POST", "/posts", map[string]string{"Idempotency-Key": p.SlotID + "-" + name}, body)
	if err != nil {
		return "", err
	}
	var res struct {
		Post    zPost `json:"post"`
		Details struct {
			ExistingPostID string `json:"existingPostId"`
		} `json:"details"`
	}
	_ = json.Unmarshal(b, &res)
	id := res.Post.ID
	if st == 409 && res.Details.ExistingPostID != "" {
		id = res.Details.ExistingPostID
	} else if st < 200 || st > 299 {
		return "", apiError("POST", z.base+"/posts", st, b)
	}
	if id == "" {
		return "", errors.New(name + ": post response had no id")
	}

	for n := 0; ; n++ {
		var r struct {
			Post zPost `json:"post"`
		}
		if err := z.zOK(ctx, "GET", "/posts/"+url.PathEscape(id), nil, nil, &r); err != nil {
			return "", fmt.Errorf("%s: post %s exists but cannot be read: %w", name, id, err)
		}
		switch status, msg := r.Post.state(name); status {
		case "published":
			return id, nil
		case "failed", "cancelled":
			return "", fmt.Errorf("%s: post %s %s: %s", name, id, status, msg)
		}
		if time.Duration(n+1)*z.pollEvery > z.pollFor {
			slog.Warn(name+" still publishing", "post", id)
			return id, nil
		}
		if err := sleepCtx(ctx, z.pollEvery); err != nil {
			return "", err
		}
	}
}
