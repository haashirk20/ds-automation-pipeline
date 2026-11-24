package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata"
)

const defaultFont = "Montserrat SemiBold"

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: uploader init|due|tick|auth-google")
		os.Exit(2)
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1], time.Now(), os.Getenv); err != nil {
		slog.Error("failed", "cmd", os.Args[1], "err", err.Error())
		stop()
		os.Exit(1)
	}
}

func run(ctx context.Context, cmd string, now time.Time, getenv func(string) string) error {
	// tokens ride on these requests, so redirects are never followed
	hc := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	if cmd == "auth-google" {
		return authGoogle(ctx, hc, googleTokenURL, getenv("GOOGLE_CLIENT_ID"), getenv("GOOGLE_CLIENT_SECRET"), os.Stdout)
	}
	if cmd != "init" && cmd != "due" && cmd != "tick" {
		return fmt.Errorf("unknown command %q", cmd)
	}
	root := getenv("DRIVE_ROOT_ID")
	if root == "" {
		return fmt.Errorf("DRIVE_ROOT_ID is not set")
	}
	auth := &googleAuth{
		clientID: getenv("GOOGLE_CLIENT_ID"), clientSecret: getenv("GOOGLE_CLIENT_SECRET"),
		refreshToken: getenv("GOOGLE_REFRESH_TOKEN"), hc: hc, tokenURL: googleTokenURL,
		now: time.Now,
	}
	d := newDrive(hc, auth.Token)
	if cmd == "init" {
		return initLayout(ctx, d, root, os.Stdout)
	}

	if getenv("FONT_FILE") != "" {
		return fmt.Errorf("FONT_FILE was replaced by FONT_FAMILY")
	}
	font := getenv("FONT_FAMILY")
	if font == "" {
		font = defaultFont
	}
	hook := getenv("ALERT_DISCORD_WEBHOOK")
	if hook != "" && !isDiscordWebhook(hook) {
		slog.Warn("ALERT_DISCORD_WEBHOOK is not a Discord webhook URL; Discord messages are off")
		hook = ""
	}
	t := &ticker{d: d, root: root, pubs: map[string]Publisher{}, font: font, pango: "pango-view", dryRun: getenv("DRY_RUN") == "1",
		log: slog.Default(), ffmpeg: "ffmpeg", ffprobe: "ffprobe", discord: hook, hc: hc}
	if cmd == "due" {
		due, err := t.isDue(ctx, now)
		if err != nil {
			return err
		}
		if due {
			fmt.Println("due")
		} else {
			fmt.Println("idle")
		}
		return nil
	}

	if page, tok := getenv("META_PAGE_ID"), getenv("META_PAGE_TOKEN"); page != "" && tok != "" {
		t.pubs["facebook"] = newFacebook(page, tok, hc)
		if ig := getenv("META_IG_USER_ID"); ig != "" {
			t.pubs["instagram"] = newInstagram(ig, tok, hc)
		}
	}
	if key := getenv("ZERNIO_API_KEY"); key != "" {
		z := newZernio(key, hc)
		t.pubs["youtube"], t.pubs["tiktok"] = z.youtube(), z.tiktok()
	}
	manual := ""
	if id := getenv("POST_NOW"); id != "" { // the workflow run ID, so a re-run of the same run cannot post twice
		manual = "manual " + id
	}
	return t.tick(ctx, now, manual)
}
