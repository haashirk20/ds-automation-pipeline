package main

import "strings"

// parseCaptions returns one caption per line; a literal \n becomes a line break.
func parseCaptions(text string) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		out = append(out, strings.ReplaceAll(line, `\n`, "\n"))
	}
	return out
}
