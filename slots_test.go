package main

import (
	"testing"
	"time"
)

func mustSet(t *testing.T, text string) Settings {
	t.Helper()
	s, err := parseSettings(text)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func ids(sl []slot) []string {
	var out []string
	for _, s := range sl {
		out = append(out, s.ID)
	}
	return out
}

func TestDueSlots(t *testing.T) {
	s := mustSet(t, "times = 09:00, 09:00, 18:00\ntimezone = America/Toronto")
	// 2026-11-12 10:30 Toronto (EST, UTC-5) = 15:30Z
	now := time.Date(2026, 11, 12, 15, 30, 0, 0, time.UTC)
	got := ids(dueSlots(s, state{}, now))
	want := []string{"2026-11-12 09:00#1", "2026-11-12 09:00#2"}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %v", got)
	}
	// claimed slot is skipped
	st := state{Claims: map[string]string{"2026-11-12 09:00#1": "x"}}
	if g := ids(dueSlots(s, st, now)); len(g) != 1 || g[0] != want[1] {
		t.Fatalf("got %v", g)
	}
	// more than 3 h late: not due
	late := time.Date(2026, 11, 12, 17, 1, 0, 0, time.UTC) // 12:01 local
	if g := dueSlots(s, state{}, late); len(g) != 0 {
		t.Fatalf("got %v", ids(g))
	}
	// before the slot: not due
	early := time.Date(2026, 11, 12, 13, 59, 0, 0, time.UTC) // 08:59 local
	if g := dueSlots(s, state{}, early); len(g) != 0 {
		t.Fatalf("got %v", ids(g))
	}
}

func TestDueSlotsAcrossMidnight(t *testing.T) {
	s := mustSet(t, "times = 23:30\ntimezone = America/Toronto")
	now := time.Date(2026, 11, 13, 5, 10, 0, 0, time.UTC) // 00:10 local on the 13th
	got := ids(dueSlots(s, state{}, now))
	if len(got) != 1 || got[0] != "2026-11-12 23:30#1" {
		t.Fatalf("got %v", got)
	}
}

func TestDueSlotsPaused(t *testing.T) {
	s := mustSet(t, "times = 09:00\ntimezone = UTC\npaused = yes")
	if g := dueSlots(s, state{}, time.Date(2026, 11, 12, 9, 30, 0, 0, time.UTC)); len(g) != 0 {
		t.Fatal("paused must have nothing due")
	}
}

func TestClaimPrunes(t *testing.T) {
	now := time.Date(2026, 11, 12, 12, 0, 0, 0, time.UTC)
	st := state{Claims: map[string]string{
		"old":  now.Add(-49 * time.Hour).Format(time.RFC3339),
		"new":  now.Add(-47 * time.Hour).Format(time.RFC3339),
		"junk": "not a time",
	}}
	claim(&st, "s", now)
	if _, ok := st.Claims["old"]; ok {
		t.Error("old claim kept")
	}
	for _, k := range []string{"new", "junk", "s"} {
		if _, ok := st.Claims[k]; !ok {
			t.Errorf("%s dropped", k)
		}
	}
	if st.Claims["s"] != "2026-11-12T12:00:00Z" {
		t.Errorf("claim time %q", st.Claims["s"])
	}
}
