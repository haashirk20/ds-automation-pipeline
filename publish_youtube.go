package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

type youtube struct {
	auth     *googleAuth
	hc       *http.Client
	ytUpload string
}

func newYouTube(auth *googleAuth, hc *http.Client) Publisher {
	return &youtube{auth, hc, "https://www.googleapis.com"}
}

func (y *youtube) Name() string { return "youtube" }

func (y *youtube) Publish(ctx context.Context, p Post) (string, error) {
	tok, err := y.auth.Token(ctx)
	if err != nil {
		return "", err
	}
	f, size, err := openFile(p.File)
	if err != nil {
		return "", err
	}
	defer f.Close()
	meta, _ := json.Marshal(map[string]any{
		"snippet": map[string]any{"title": p.Title, "description": strings.NewReplacer("<", "", ">", "").Replace(p.Text), "categoryId": "22"},
		"status":  map[string]any{"privacyStatus": p.Privacy, "selfDeclaredMadeForKids": false},
	})
	_, h, err := callH(ctx, y.hc, apiTimeout, "POST", y.ytUpload+"/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", map[string]string{
		"Authorization": "Bearer " + tok, "Content-Type": "application/json; charset=UTF-8",
		"X-Upload-Content-Type": "video/mp4", "X-Upload-Content-Length": fmt.Sprint(size),
	}, strings.NewReader(string(meta)), int64(len(meta)))
	if err != nil {
		return "", err
	}
	loc := h.Get("Location")
	if loc == "" {
		return "", errors.New("youtube: init returned no Location")
	}
	// The session URL carries its own upload_id; the bearer token goes only to Google's own https host.
	hdr := map[string]string{"Content-Type": "video/mp4"}
	if sessionGetsToken(loc) {
		hdr["Authorization"] = "Bearer " + tok
	}
	b, err := callOK(ctx, y.hc, uploadTimeout, "PUT", loc, hdr, f, size)
	if err != nil {
		return "", err
	}
	var out struct{ ID string }
	if json.Unmarshal(b, &out) != nil || out.ID == "" {
		return "", errors.New("youtube: upload response had no id")
	}
	return out.ID, nil
}

func sessionGetsToken(loc string) bool {
	u, err := url.Parse(loc)
	return err == nil && u.Scheme == "https" && u.Host == "www.googleapis.com"
}
