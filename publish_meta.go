package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const graphVersion = "v26.0"

// call sends one request with its own timeout and no redirect following. It never retries.
// Errors carry method, host+path and status, never the query string or any header.
func call(ctx context.Context, hc *http.Client, timeout time.Duration, method, rawURL string, hdr map[string]string, body io.Reader, size int64) (int, []byte, http.Header, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, rawURL, body)
	if err != nil {
		return 0, nil, nil, fmt.Errorf("%s: bad request", method)
	}
	if size >= 0 && body != nil {
		req.ContentLength = size
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	c := *hc
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := c.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		u, _ := url.Parse(rawURL)
		return 0, nil, nil, fmt.Errorf("%s %s%s: %v", method, u.Host, u.Path, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return resp.StatusCode, nil, nil, fmt.Errorf("%s: reading response: %v", method, err)
	}
	return resp.StatusCode, b, resp.Header, nil
}

// callH is call plus an error for any non-2xx status; it also returns the response headers.
func callH(ctx context.Context, hc *http.Client, timeout time.Duration, method, rawURL string, hdr map[string]string, body io.Reader, size int64) ([]byte, http.Header, error) {
	st, b, h, err := call(ctx, hc, timeout, method, rawURL, hdr, body, size)
	if err != nil {
		return nil, nil, err
	}
	if st < 200 || st > 299 {
		return nil, nil, apiError(method, rawURL, st, b)
	}
	return b, h, nil
}

func callOK(ctx context.Context, hc *http.Client, timeout time.Duration, method, rawURL string, hdr map[string]string, body io.Reader, size int64) ([]byte, error) {
	b, _, err := callH(ctx, hc, timeout, method, rawURL, hdr, body, size)
	return b, err
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

func openFile(path string) (*os.File, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, err
	}
	return f, st.Size(), nil
}

const (
	apiTimeout    = 60 * time.Second
	uploadTimeout = 15 * time.Minute
)

type metaBase struct {
	id, token, graph, rupload string
	hc                        *http.Client
}

func (m *metaBase) auth(scheme string) map[string]string {
	return map[string]string{"Authorization": scheme + " " + m.token}
}

func (m *metaBase) form(ctx context.Context, path string, v url.Values) (map[string]any, error) {
	h := m.auth("Bearer")
	h["Content-Type"] = "application/x-www-form-urlencoded"
	b, err := callOK(ctx, m.hc, apiTimeout, "POST", m.graph+path, h, strings.NewReader(v.Encode()), -1)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("POST %s: bad JSON response", path)
	}
	return out, nil
}

func (m *metaBase) upload(ctx context.Context, path, file string) error {
	f, size, err := openFile(file)
	if err != nil {
		return err
	}
	defer f.Close()
	h := m.auth("OAuth")
	h["offset"] = "0"
	h["file_size"] = fmt.Sprint(size)
	_, err = callOK(ctx, m.hc, uploadTimeout, "POST", m.rupload+path, h, f, size)
	return err
}

func str(m map[string]any, k string) string { s, _ := m[k].(string); return s }

// Facebook Page Reels.
type facebook struct {
	metaBase
}

func newFacebook(pageID, token string, hc *http.Client) Publisher {
	return &facebook{metaBase{pageID, token, "https://graph.facebook.com/" + graphVersion, "https://rupload.facebook.com", hc}}
}

func (f *facebook) Name() string { return "facebook" }

func (f *facebook) Publish(ctx context.Context, p Post) (string, error) {
	reels := "/" + f.id + "/video_reels"
	r, err := f.form(ctx, reels, url.Values{"upload_phase": {"start"}})
	if err != nil {
		return "", err
	}
	vid := str(r, "video_id")
	if vid == "" {
		return "", errors.New("facebook: start returned no video_id")
	}
	if err := f.upload(ctx, "/video-upload/"+graphVersion+"/"+vid, p.File); err != nil {
		return "", err
	}
	if _, err := f.form(ctx, reels, url.Values{"upload_phase": {"finish"}, "video_id": {vid}, "video_state": {"PUBLISHED"}, "description": {p.Text}}); err != nil {
		return "", err
	}
	return vid, nil
}

// Instagram Reels.
type instagram struct {
	metaBase
	pollEvery, pollFor time.Duration
}

func newInstagram(igUserID, token string, hc *http.Client) Publisher {
	return &instagram{metaBase{igUserID, token, "https://graph.facebook.com/" + graphVersion, "https://rupload.facebook.com", hc}, 10 * time.Second, 10 * time.Minute}
}

func (i *instagram) Name() string { return "instagram" }

func (i *instagram) Publish(ctx context.Context, p Post) (string, error) {
	r, err := i.form(ctx, "/"+i.id+"/media", url.Values{"media_type": {"REELS"}, "upload_type": {"resumable"}, "caption": {p.Text}, "share_to_feed": {"true"}})
	if err != nil {
		return "", err
	}
	cid := str(r, "id")
	if cid == "" {
		return "", errors.New("instagram: container create returned no id")
	}
	if err := i.upload(ctx, "/ig-api-upload/"+graphVersion+"/"+cid, p.File); err != nil {
		return "", err
	}
	for n := 0; ; n++ {
		b, err := callOK(ctx, i.hc, apiTimeout, "GET", i.graph+"/"+cid+"?fields=status_code", i.auth("Bearer"), nil, -1)
		var s map[string]any
		if err != nil {
			slog.Warn("instagram status poll failed, will retry", "err", err.Error())
		} else {
			_ = json.Unmarshal(b, &s)
		}
		switch sc := str(s, "status_code"); sc {
		case "FINISHED":
			r, err := i.form(ctx, "/"+i.id+"/media_publish", url.Values{"creation_id": {cid}})
			if err != nil {
				return "", err
			}
			if id := str(r, "id"); id != "" {
				return id, nil
			}
			return "", errors.New("instagram: media_publish returned no id")
		case "ERROR", "EXPIRED":
			return "", fmt.Errorf("instagram: container status %s", sc)
		}
		if time.Duration(n+1)*i.pollEvery > i.pollFor {
			return "", errors.New("instagram: container not finished in time")
		}
		if err := sleepCtx(ctx, i.pollEvery); err != nil {
			return "", err
		}
	}
}
