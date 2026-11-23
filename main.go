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

const defaultFont = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: uploader init|due|tick|serve|auth-google")
		os.Exit(2)
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	var ctx, stopNew context.Context // ctx cancels in-flight work, stopNew only stops starting new work
	var stop func()
	if os.Args[1] == "serve" {
		ctx, stopNew = serveSignals(15 * time.Minute)
		stop = func() {}
	} else {
		ctx, stop = signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		stopNew = ctx
	}
	defer stop()
	if err := run(ctx, stopNew, os.Args[1], time.Now(), time.Now, os.Getenv); err != nil {
		slog.Error("failed", "cmd", os.Args[1], "err", err.Error())
		stop()
		os.Exit(1)
	}
}

func run(ctx, stopNew context.Context, cmd string, now time.Time, clock func() time.Time, getenv func(string) string) error {
	// tokens ride on these requests, so redirects are never followed
	hc := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

	if cmd == "auth-google" {
		return authGoogle(ctx, hc, googleTokenURL, getenv("GOOGLE_CLIENT_ID"), getenv("GOOGLE_CLIENT_SECRET"), os.Stdout)
	}
	if cmd != "init" && cmd != "due" && cmd != "tick" && cmd != "serve" {
		return fmt.Errorf("unknown command %q", cmd)
	}
	root := getenv("DRIVE_ROOT_ID")
	if root == "" {
		return fmt.Errorf("DRIVE_ROOT_ID is not set")
	}
	if cmd == "serve" || cmd == "tick" {
		path := getenv("LOCK_FILE")
		if path == "" {
			path = "/run/uploader/lock"
		}
		lock, err := lockFile(path)
		if err != nil {
			return err
		}
		defer lock.Close()
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

	font := getenv("FONT_FILE")
	if font == "" {
		font = defaultFont
	}
	t := &ticker{d: d, root: root, pubs: map[string]Publisher{}, font: font, dryRun: getenv("DRY_RUN") == "1",
		log: slog.Default(), ffmpeg: "ffmpeg", ffprobe: "ffprobe"}
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
	if cmd == "serve" {
		return serveCmd(ctx, stopNew, t, clock, getenv)
	}
	return t.tick(ctx, now)
}
