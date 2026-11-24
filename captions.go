package main

import (
	"fmt"
	"strings"
)

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

// isComment: "# note" and a lone "#" are comments; "#tarot" is a hashtag and stays.
func isComment(line string) bool {
	return line == "#" || strings.HasPrefix(line, "# ")
}

// parseProducts reads "[Product]" headers, each followed by that product's caption lines.
// Blank edges are trimmed. A duplicate header is an error.
func parseProducts(text string) (map[string]string, error) {
	out := map[string]string{}
	name, in := "", false
	var body []string
	flush := func() {
		if in {
			out[name] = strings.TrimSpace(strings.Join(body, "\n"))
		}
		body = nil
	}
	for i, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if isComment(line) {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			flush()
			name, in = strings.TrimSpace(line[1:len(line)-1]), true
			if _, dup := out[name]; dup {
				return nil, fmt.Errorf("products line %d: duplicate product %q", i+1, name)
			}
			out[name] = "" // reserve so a later duplicate is caught
			continue
		}
		if !in {
			if line != "" {
				return nil, fmt.Errorf("products line %d: text before the first [product] header", i+1)
			}
			continue
		}
		body = append(body, line)
	}
	flush()
	return out, nil
}
