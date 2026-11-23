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
	"time"
)

type tiktok struct {
	key, zernio        string
	hc                 *http.Client
	pollEvery, pollFor time.Duration
}

func newTikTok(apiKey string, hc *http.Client) Publisher {
	return &tiktok{apiKey, "https://zernio.com/api/v1", hc, 10 * time.Second, 5 * time.Minute}
}

func (t *tiktok) Name() string { return "tiktok" }

type zPost struct {
	ID        string `json:"_id"`
	Status    string `json:"status"`
	Platforms []struct {
		Platform     string `json:"platform"`
		Status       string `json:"status"`
		ErrorMessage string `json:"errorMessage"`
	} `json:"platforms"`
}

func (p zPost) state() (status, errMsg string) {
	for _, e := range p.Platforms {
		if e.Platform == "tiktok" {
			return e.Status, e.ErrorMessage
		}
	}
	return p.Status, ""
}

// z calls the Zernio API and returns status and body without judging the status.
func (t *tiktok) z(ctx context.Context, method, path string, extra map[string]string, in any) (int, []byte, error) {
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
	st, b, _, err := call(ctx, t.hc, apiTimeout, method, t.zernio+path, h, body, size)
	return st, b, err
}

// zOK is z plus an error for any non-2xx status, decoding the JSON answer into out.
func (t *tiktok) zOK(ctx context.Context, method, path string, extra map[string]string, in, out any) error {
	st, b, err := t.z(ctx, method, path, extra, in)
	if err != nil {
		return err
	}
	if st < 200 || st > 299 {
		return apiError(method, t.zernio+path, st, b)
	}
	if err := json.Unmarshal(b, out); err != nil {
		return fmt.Errorf("%s %s: bad JSON response", method, path)
	}
	return nil
}

func (t *tiktok) Publish(ctx context.Context, p Post) (string, error) {
	var accs struct {
		Accounts []struct {
			ID       string `json:"_id"`
			Platform string `json:"platform"`
			Active   *bool  `json:"isActive"`
		} `json:"accounts"`
	}
	if err := t.zOK(ctx, "GET", "/accounts", nil, nil, &accs); err != nil {
		return "", err
	}
	acct := ""
	for _, a := range accs.Accounts {
		if a.Platform == "tiktok" && (a.Active == nil || *a.Active) {
			acct = a.ID
			break
		}
	}
	if acct == "" {
		return "", errors.New("tiktok: no active tiktok account")
	}

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
	if err := t.zOK(ctx, "GET", "/accounts/"+url.PathEscape(acct)+"/tiktok/creator-info?mediaType=video", nil, nil, &info); err != nil {
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

	f, size, err := openFile(p.File)
	if err != nil {
		return "", err
	}
	defer f.Close()
	var pre struct {
		UploadURL string `json:"uploadUrl"`
		PublicURL string `json:"publicUrl"`
	}
	if err := t.zOK(ctx, "POST", "/media/presign", nil, map[string]any{"filename": filepath.Base(p.File), "contentType": "video/mp4", "size": size}, &pre); err != nil {
		return "", err
	}
	if pre.UploadURL == "" || pre.PublicURL == "" {
		return "", errors.New("tiktok: presign returned no URL")
	}
	// No Authorization header: the presigned URL is a third-party host.
	if _, err := callOK(ctx, t.hc, uploadTimeout, "PUT", pre.UploadURL, map[string]string{"Content-Type": "video/mp4"}, f, size); err != nil {
		return "", err
	}

	st, b, err := t.z(ctx, "POST", "/posts", map[string]string{"Idempotency-Key": p.SlotID + "-tiktok"}, map[string]any{
		"content": p.Text, "publishNow": true,
		"platforms":  []any{map[string]any{"platform": "tiktok", "accountId": acct}},
		"mediaItems": []any{map[string]any{"type": "video", "url": pre.PublicURL}},
		"tiktokSettings": map[string]any{
			"privacy_level": "PUBLIC_TO_EVERYONE", "allow_comment": allow("allow_comment"), "allow_duet": allow("allow_duet"),
			"allow_stitch": allow("allow_stitch"), "content_preview_confirmed": true, "express_consent_given": true,
			"video_made_with_ai": false, "commercialContentType": "brand_organic",
		},
	})
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
		return "", apiError("POST", t.zernio+"/posts", st, b)
	}
	if id == "" {
		return "", errors.New("tiktok: post response had no id")
	}

	for n := 0; ; n++ {
		var r struct {
			Post zPost `json:"post"`
		}
		if err := t.zOK(ctx, "GET", "/posts/"+url.PathEscape(id), nil, nil, &r); err != nil {
			return "", fmt.Errorf("tiktok: post %s exists but cannot be read: %w", id, err)
		}
		switch status, msg := r.Post.state(); status {
		case "published":
			return id, nil
		case "failed", "cancelled":
			return "", fmt.Errorf("tiktok: post %s %s: %s", id, status, msg)
		}
		if time.Duration(n+1)*t.pollEvery > t.pollFor {
			slog.Warn("tiktok still publishing", "post", id)
			return id, nil
		}
		if err := sleepCtx(ctx, t.pollEvery); err != nil {
			return "", err
		}
	}
}
