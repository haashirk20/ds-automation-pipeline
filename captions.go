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
		if line == "" || isComment(line) {
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
// Text before the first header is ignored. A [Name] line is a header only when Name is one of folders; otherwise it is caption text
// and a warning is returned. Blank edges are trimmed. A duplicate header is an error.
func parseProducts(text string, folders map[string]bool) (map[string]string, []string, error) {
	out := map[string]string{}
	var warns []string
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
			n := strings.TrimSpace(line[1 : len(line)-1])
			if folders[n] {
				flush()
				name, in = n, true
				if _, dup := out[name]; dup {
					return nil, nil, fmt.Errorf("products line %d: duplicate product %q", i+1, name)
				}
				out[name] = "" // reserve so a later duplicate is caught
				continue
			}
			warns = append(warns, fmt.Sprintf("products line %d: [%s] does not match a product folder", i+1, n))
		}
		if !in { // text before the first known header belongs to no product
			continue
		}
		body = append(body, line)
	}
	flush()
	return out, warns, nil
}
