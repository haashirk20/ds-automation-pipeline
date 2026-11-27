package main

import (
	"fmt"
	"slices"
	"time"
)

type slot struct {
	ID string
	At time.Time
}

type state struct {
	Claims map[string]string `json:"claims"`
	// Posted maps a Drive video file ID to "slotID RFC3339time". Never pruned: a posted clip is never reposted.
	Posted map[string]string `json:"posted,omitempty"`
}

const slotWindow = 3 * time.Hour

// dueSlots lists unclaimed slots from yesterday and today (local) that started within the last 3 h.
func dueSlots(s Settings, st state, now time.Time) []slot {
	if s.Paused {
		return nil
	}
	var out []slot
	local := now.In(s.Loc)
	for back := 1; back >= 0; back-- {
		day := local.AddDate(0, 0, -back)
		count := map[string]int{}
		for _, hm := range s.Times {
			count[hm]++
			var h, m int
			fmt.Sscanf(hm, "%d:%d", &h, &m)
			at := time.Date(day.Year(), day.Month(), day.Day(), h, m, 0, 0, s.Loc)
			id := fmt.Sprintf("%s %s#%d", at.Format("2006-01-02"), hm, count[hm])
			if _, claimed := st.Claims[id]; claimed || at.After(now) || now.Sub(at) > slotWindow {
				continue
			}
			out = append(out, slot{ID: id, At: at})
		}
	}
	slices.SortStableFunc(out, func(a, b slot) int { return a.At.Compare(b.At) })
	return out
}

// claim records the slot and drops claims older than 2 days (unparseable ones are kept).
func claim(st *state, id string, now time.Time) {
	if st.Claims == nil {
		st.Claims = map[string]string{}
	}
	for k, v := range st.Claims {
		if t, err := time.Parse(time.RFC3339, v); err == nil && now.Sub(t) > 48*time.Hour {
			delete(st.Claims, k)
		}
	}
	st.Claims[id] = now.UTC().Format(time.RFC3339)
}
