package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	folderMime = "application/vnd.google-apps.folder"
	docMime    = "application/vnd.google-apps.document"
)

type drive struct {
	hc     *http.Client
	token  func(context.Context) (string, error)
	api    string // https://www.googleapis.com/drive/v3
	upload string // https://www.googleapis.com/upload/drive/v3
}

type driveFile struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
}

func newDrive(hc *http.Client, token func(context.Context) (string, error)) *drive {
	return &drive{hc: hc, token: token,
		api: "https://www.googleapis.com/drive/v3", upload: "https://www.googleapis.com/upload/drive/v3"}
}

// do sends one authorised request; a non-2xx status becomes an apiError. Caller closes the body.
func (d *drive) do(ctx context.Context, method, u string, body io.Reader, ctype string) (*http.Response, error) {
	tok, err := d.token(ctx)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	resp, err := httpDo(d.hc, req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
		resp.Body.Close()
		return nil, apiError(method, u, resp.StatusCode, b)
	}
	return resp, nil
}

// getBytes fetches u fully (small bodies only: JSON, docs, state).
func (d *drive) getBytes(ctx context.Context, u string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	resp, err := d.do(ctx, "GET", u, nil, "")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(io.LimitReader(resp.Body, 8<<20))
}

func qEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `'`, `\'`).Replace(s)
}

func (d *drive) query(ctx context.Context, q string) ([]driveFile, error) {
	var all []driveFile
	page := ""
	for {
		v := url.Values{"q": {q}, "pageSize": {"1000"}, "fields": {"nextPageToken,files(id,name,mimeType)"}}
		if page != "" {
			v.Set("pageToken", page)
		}
		b, err := d.getBytes(ctx, d.api+"/files?"+v.Encode())
		if err != nil {
			return nil, err
		}
		var r struct {
			NextPageToken string      `json:"nextPageToken"`
			Files         []driveFile `json:"files"`
		}
		if err := json.Unmarshal(b, &r); err != nil {
			return nil, fmt.Errorf("drive list: bad JSON")
		}
		all = append(all, r.Files...)
		if r.NextPageToken == "" {
			return all, nil
		}
		page = r.NextPageToken
	}
}

func (d *drive) find(ctx context.Context, parent, name string) ([]driveFile, error) {
	return d.query(ctx, fmt.Sprintf("'%s' in parents and name='%s' and trashed=false", qEscape(parent), qEscape(name)))
}

// list returns the files in parent whose mimeType contains the given text.
func (d *drive) list(ctx context.Context, parent, mimeContains string) ([]driveFile, error) {
	return d.query(ctx, fmt.Sprintf("'%s' in parents and trashed=false and mimeType contains '%s'", qEscape(parent), qEscape(mimeContains)))
}

// listFolders returns the subfolders of parent.
func (d *drive) listFolders(ctx context.Context, parent string) ([]driveFile, error) {
	return d.query(ctx, fmt.Sprintf("'%s' in parents and trashed=false and mimeType = '%s'", qEscape(parent), folderMime))
}

// resolve finds each named item in root; a missing or duplicated name is an error.
func (d *drive) resolve(ctx context.Context, root string, names ...string) (map[string]string, error) {
	ids := map[string]string{}
	for _, n := range names {
		fs, err := d.find(ctx, root, n)
		if err != nil {
			return nil, err
		}
		if len(fs) != 1 {
			return nil, fmt.Errorf("drive: expected exactly one %q in root, found %d (run init?)", n, len(fs))
		}
		ids[n] = fs[0].ID
	}
	return ids, nil
}

func (d *drive) exportText(ctx context.Context, id string) (string, error) {
	b, err := d.getBytes(ctx, d.api+"/files/"+url.PathEscape(id)+"/export?mimeType=text/plain")
	if err != nil {
		return "", err
	}
	s := strings.TrimPrefix(string(b), "\xef\xbb\xbf")
	return strings.ReplaceAll(s, "\r", ""), nil
}

func (d *drive) media(ctx context.Context, id string) ([]byte, error) {
	return d.getBytes(ctx, d.api+"/files/"+url.PathEscape(id)+"?alt=media")
}

// download streams a file to dest without holding it in memory.
func (d *drive) download(ctx context.Context, id, dest string) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	resp, err := d.do(ctx, "GET", d.api+"/files/"+url.PathEscape(id)+"?alt=media", nil, "")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		return fmt.Errorf("drive download: %w", err)
	}
	return f.Close()
}

// update replaces the content of an existing file.
func (d *drive) update(ctx context.Context, id string, data []byte, ctype string) error {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	resp, err := d.do(ctx, "PATCH", d.upload+"/files/"+url.PathEscape(id)+"?uploadType=media", bytes.NewReader(data), ctype)
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

// create makes a folder (mime == folderMime, no content) or a file/doc with content.
func (d *drive) create(ctx context.Context, parent, name, mime string, content []byte, contentType string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	meta, _ := json.Marshal(map[string]any{"name": name, "mimeType": mime, "parents": []string{parent}})
	var resp *http.Response
	var err error
	if mime == folderMime {
		resp, err = d.do(ctx, "POST", d.api+"/files?fields=id", bytes.NewReader(meta), "application/json")
	} else {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		p, _ := mw.CreatePart(textproto.MIMEHeader{"Content-Type": {"application/json"}})
		p.Write(meta)
		p, _ = mw.CreatePart(textproto.MIMEHeader{"Content-Type": {contentType}})
		p.Write(content)
		mw.Close()
		resp, err = d.do(ctx, "POST", d.upload+"/files?uploadType=multipart&fields=id", &buf, "multipart/related; boundary="+mw.Boundary())
	}
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var r driveFile
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&r); err != nil || r.ID == "" {
		return "", fmt.Errorf("drive create %q: bad response", name)
	}
	return r.ID, nil
}

const defaultSettings = `# one post per time; list a time twice for two posts
times = 09:00, 18:00
timezone = America/Toronto
platforms = youtube, instagram, facebook, tiktok
# text burned on the video when the product has no lines in the captions doc
burn_text =
# post text for a video with no product entry in the products doc (may be empty)
default_caption =
# added under the product caption in the post text, never burned on the video
hashtags = #shorts #fyp
burn_caption = yes
# 0..1, music volume under the video's own sound
music_volume = 0.25
youtube_privacy = public
paused = no
`

const defaultCaptions = `# text burned on the video, one section per product; a random line of the section is used
# the [name] must match the product's folder name in videos/ exactly; a literal \n makes a line break
# a product with no section uses burn_text from settings
# [Velvet Tarot Deck]
# comment BOOK if you want one! 📖✨
# Wait for it 👀
`

const defaultProducts = `# post text under the video, one section per product
# the [name] must match the product's folder name in videos/ exactly
# the caption can span several lines; hashtags from settings are added after it
# [Velvet Tarot Deck]
# Hand-gilded tarot deck ✨ Link in bio #tarot
`

// initLayout creates what is missing under root and prints the IDs. It refuses on duplicates.
func initLayout(ctx context.Context, d *drive, root string, out io.Writer) error {
	type item struct {
		name, mime, ctype string
		content           string
	}
	items := []item{
		{"videos", folderMime, "", ""},
		{"music", folderMime, "", ""},
		{"settings", docMime, "text/plain", defaultSettings},
		{"captions", docMime, "text/plain", defaultCaptions},
		{"products", docMime, "text/plain", defaultProducts},
		{"state.json", "application/json", "application/json", `{"claims":{}}`},
	}
	found := map[string]string{}
	for _, it := range items {
		fs, err := d.find(ctx, root, it.name)
		if err != nil {
			return err
		}
		if len(fs) > 1 {
			return fmt.Errorf("init: %d items named %q in root; remove the extras first", len(fs), it.name)
		}
		if len(fs) == 1 {
			found[it.name] = fs[0].ID
		}
	}
	for _, it := range items {
		id, ok := found[it.name]
		state := "exists"
		if !ok {
			var err error
			id, err = d.create(ctx, root, it.name, it.mime, []byte(it.content), it.ctype)
			if err != nil {
				return err
			}
			state = "created"
		}
		fmt.Fprintf(out, "%s %s %s\n", it.name, id, state)
	}
	return nil
}
