package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	googleTokenURL = "https://oauth2.googleapis.com/token"
	googleAuthURL  = "https://accounts.google.com/o/oauth2/v2/auth"
	googleScopes   = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/youtube.upload"
)

type googleAuth struct {
	clientID, clientSecret, refreshToken string
	hc                                   *http.Client
	tokenURL                             string
	now                                  func() time.Time // set by main so only main reads the clock
	tok                                  string
	exp                                  time.Time
}

// Token returns a cached access token, refreshing it when within 60 s of expiry.
func (g *googleAuth) Token(ctx context.Context) (string, error) {
	if g.tok != "" && g.now().Before(g.exp.Add(-60*time.Second)) {
		return g.tok, nil
	}
	res, err := postToken(ctx, g.hc, g.tokenURL, url.Values{
		"client_id":     {g.clientID},
		"client_secret": {g.clientSecret},
		"refresh_token": {g.refreshToken},
		"grant_type":    {"refresh_token"},
	})
	if err != nil {
		return "", err
	}
	g.tok = res.AccessToken
	g.exp = g.now().Add(time.Duration(res.ExpiresIn) * time.Second)
	return g.tok, nil
}

type tokenResp struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
}

func postToken(ctx context.Context, hc *http.Client, tokenURL string, form url.Values) (tokenResp, error) {
	var out tokenResp
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return out, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := httpDo(hc, req)
	if err != nil {
		return out, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != 200 {
		return out, apiError("POST", tokenURL, resp.StatusCode, body)
	}
	if err := json.Unmarshal(body, &out); err != nil || out.AccessToken == "" {
		return out, fmt.Errorf("POST %s: bad token response", req.URL.Host+req.URL.Path)
	}
	return out, nil
}

// authGoogle is the one-time consent helper. It prints the refresh token to out.
func authGoogle(ctx context.Context, hc *http.Client, tokenURL, clientID, clientSecret string, out io.Writer) error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer ln.Close()
	redirect := fmt.Sprintf("http://127.0.0.1:%d/", ln.Addr().(*net.TCPAddr).Port)
	sb := make([]byte, 16)
	rand.Read(sb)
	state := hex.EncodeToString(sb)

	codeCh := make(chan string, 1)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("state") != state || q.Get("code") == "" {
			http.Error(w, "bad request", 400)
			return
		}
		fmt.Fprintln(w, "Done. You can close this tab.")
		select {
		case codeCh <- q.Get("code"):
		default:
		}
	})}
	go srv.Serve(ln)
	defer srv.Close()

	fmt.Fprintln(out, googleAuthURL+"?"+url.Values{
		"client_id":     {clientID},
		"redirect_uri":  {redirect},
		"response_type": {"code"},
		"scope":         {googleScopes},
		"access_type":   {"offline"},
		"prompt":        {"consent"},
		"state":         {state},
	}.Encode())

	var code string
	select {
	case code = <-codeCh:
	case <-time.After(5 * time.Minute):
		return fmt.Errorf("auth-google: timed out waiting for consent")
	case <-ctx.Done():
		return ctx.Err()
	}
	res, err := postToken(ctx, hc, tokenURL, url.Values{
		"client_id":     {clientID},
		"client_secret": {clientSecret},
		"code":          {code},
		"redirect_uri":  {redirect},
		"grant_type":    {"authorization_code"},
	})
	if err != nil {
		return err
	}
	if res.RefreshToken == "" {
		return fmt.Errorf("auth-google: no refresh token returned")
	}
	fmt.Fprintln(out, res.RefreshToken)
	return nil
}
