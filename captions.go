package main

import (
	"fmt"
	"strings"
)

// parseCaptions reads the captions doc: "[Product]" sections, one burn line per line
// (a literal \n becomes a line break). Same header rules as parseSections.
func parseCaptions(text string, folders map[string]bool) (map[string][]string, []string, error) {
	secs, warns, err := parseSections("captions", text, folders)
	out := map[string][]string{}
	for name, body := range secs {
		for _, line := range strings.Split(body, "\n") {
			if line = strings.TrimSpace(line); line != "" {
				out[name] = append(out[name], strings.ReplaceAll(line, `\n`, "\n"))
			}
		}
	}
	return out, warns, err
}

// isComment: "# note" and a lone "#" are comments; "#tarot" is a hashtag and stays.
func isComment(line string) bool {
	return line == "#" || strings.HasPrefix(line, "# ")
}

// parseSections reads "[Product]" headers, each followed by that product's lines.
// Text before the first header is ignored with a warning. A [Name] line is a header only when Name is one of folders; otherwise it is caption text
// and a warning is returned. Blank edges are trimmed. A duplicate header is an error.
func parseSections(doc, text string, folders map[string]bool) (map[string]string, []string, error) {
	out := map[string]string{}
	var warns []string
	name, in, stray := "", false, false
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
					return nil, nil, fmt.Errorf("%s line %d: duplicate product %q", doc, i+1, name)
				}
				out[name] = "" // reserve so a later duplicate is caught
				continue
			}
			warns = append(warns, fmt.Sprintf("%s line %d: [%s] does not match a product folder", doc, i+1, n))
			if !in {
				continue
			}
		}
		if !in { // text before the first known header belongs to no product
			if line != "" && !stray {
				stray = true
				warns = append(warns, fmt.Sprintf("%s line %d: text before the first [product] header is ignored", doc, i+1))
			}
			continue
		}
		body = append(body, line)
	}
	flush()
	return out, warns, nil
}

func parseProducts(text string, folders map[string]bool) (map[string]string, []string, error) {
	return parseSections("products", text, folders)
}
