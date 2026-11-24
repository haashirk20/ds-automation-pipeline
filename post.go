package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"
)

// Post is one finished video plus its text, handed to every publisher.
type Post struct {
	File    string // path to the final mp4
	Text    string // post text (caption + hashtags)
	Title   string // YouTube title, already cut
	SlotID  string
	Product string // for the Discord message only
	Burn    string // the text burned on the video, for the Discord message only
	Privacy string // youtube_privacy
}

type Publisher interface {
	Name() string // "youtube" | "instagram" | "facebook" | "tiktok"
	Publish(ctx context.Context, p Post) (id string, err error)
}

// apiError builds an error from a failed HTTP response. It keeps method, host+path,
// status and the API's own message, and drops the query string (it may hold tokens).
func apiError(method, rawURL string, status int, body []byte) error {
	where := rawURL
	if u, err := url.Parse(rawURL); err == nil {
		where = u.Host + u.Path
	}
	return fmt.Errorf("%s %s: HTTP %d: %s", method, where, status, apiMessage(body))
}

func apiMessage(body []byte) string {
	var e struct {
		Error            json.RawMessage `json:"error"`
		Message          string          `json:"message"`
		ErrorDescription string          `json:"error_description"`
	}
	if json.Unmarshal(body, &e) == nil {
		var obj struct {
			Message string `json:"message"`
		}
		var s string
		switch {
		case json.Unmarshal(e.Error, &obj) == nil && obj.Message != "":
			return obj.Message
		case json.Unmarshal(e.Error, &s) == nil && s != "":
			if e.ErrorDescription != "" {
				return s + ": " + e.ErrorDescription
			}
			return s
		case e.Message != "":
			return e.Message
		}
	}
	m := strings.TrimSpace(string(body))
	if utf8.RuneCountInString(m) > 200 {
		m = string([]rune(m)[:200]) + "..."
	}
	if m == "" {
		return "(empty body)"
	}
	return m
}

// httpDo sends req. A transport error is rewritten without the URL query string.
func httpDo(hc *http.Client, req *http.Request) (*http.Response, error) {
	resp, err := hc.Do(req)
	if err != nil {
		if ue, ok := err.(*url.Error); ok {
			err = ue.Err
		}
		return nil, fmt.Errorf("%s %s%s: %w", req.Method, req.URL.Host, req.URL.Path, err)
	}
	return resp, nil
}
