package keepalived

import (
	"net/netip"
	"regexp"
	"strconv"
	"strings"
)

const (
	blockBegin = "# BEGIN keepwatch"
	blockEnd   = "# END keepwatch"
	// migratedMark comments out a block KeepWatch took over, so it can be found and restored by hand.
	migratedMark = "# keepwatch-migrated: "
)

// includeBlock is the only thing KeepWatch adds to keepalived.conf.
func includeBlock(managedPath string) string {
	return blockBegin + "\ninclude " + managedPath + "\n" + blockEnd + "\n"
}

// splitBlock returns the text before, inside and after the KeepWatch block. found is false without a block.
func splitBlock(text string) (before, inside, after string, found bool) {
	start := strings.Index(text, blockBegin)
	if start < 0 {
		return text, "", "", false
	}
	rest := text[start:]
	end := strings.Index(rest, blockEnd)
	if end < 0 {
		return text, "", "", false
	}
	endAt := start + end + len(blockEnd)
	if endAt < len(text) && text[endAt] == '\n' {
		endAt++
	}
	return text[:start], text[start:endAt], text[endAt:], true
}

// outsideBlock is the main config without the KeepWatch block.
func outsideBlock(text string) string {
	before, _, after, _ := splitBlock(text)
	return before + after
}

// withInclude adds or refreshes the include block, leaving everything else as it is.
func withInclude(text, managedPath string) string {
	before, _, after, found := splitBlock(text)
	block := includeBlock(managedPath)
	if !found {
		if text != "" && !strings.HasSuffix(text, "\n") {
			text += "\n"
		}
		if text != "" {
			text += "\n"
		}
		return text + block
	}
	return before + block + after
}

// stripComments removes # and ! comments, which keepalived treats the same way.
func stripComments(text string) string {
	var b strings.Builder
	for _, line := range strings.Split(text, "\n") {
		if i := strings.IndexAny(line, "#!"); i >= 0 {
			line = line[:i]
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	return b.String()
}

var fifoKeyword = regexp.MustCompile(`(?m)^\s*(vrrp_notify_fifo|notify_fifo)\s`)

// Conflict explains why KeepWatch cannot manage a config, or returns "".
func Conflict(mainConf string) string {
	if fifoKeyword.MatchString(stripComments(outsideBlock(mainConf))) {
		return "keepalived.conf already sets a notify FIFO. Remove it so KeepWatch can track state changes."
	}
	return ""
}

// Node is a parsed keepalived block: a keyword with its arguments and child blocks.
type Node struct {
	Key      string
	Args     []string
	Children []*Node
	// Start and End are byte offsets of the block in the parsed text, End after the closing brace.
	Start, End int
}

// Parse reads keepalived config syntax into a tree. It never fails; unbalanced braces end the tree early.
func Parse(text string) []*Node {
	type tok struct {
		s     string
		start int
		end   int
		nl    bool
	}
	var toks []tok
	clean := stripCommentsKeepOffsets(text)
	i := 0
	for i < len(clean) {
		c := clean[i]
		switch {
		case c == '\n':
			toks = append(toks, tok{s: "\n", start: i, end: i + 1, nl: true})
			i++
		case c == ' ' || c == '\t' || c == '\r':
			i++
		case c == '{' || c == '}':
			toks = append(toks, tok{s: string(c), start: i, end: i + 1})
			i++
		case c == '"':
			j := strings.IndexByte(clean[i+1:], '"')
			if j < 0 {
				j = len(clean) - i - 1
			}
			toks = append(toks, tok{s: clean[i+1 : i+1+j], start: i, end: i + 2 + j})
			i += j + 2
		default:
			j := i
			for j < len(clean) && !strings.ContainsRune(" \t\r\n{}\"", rune(clean[j])) {
				j++
			}
			toks = append(toks, tok{s: clean[i:j], start: i, end: j})
			i = j
		}
	}
	pos := 0
	var parse func() []*Node
	parse = func() []*Node {
		var nodes []*Node
		var cur *Node
		for pos < len(toks) {
			t := toks[pos]
			pos++
			switch {
			case t.nl:
				cur = nil
			case t.s == "}":
				return nodes
			case t.s == "{":
				if cur == nil {
					cur = &Node{Start: t.start}
					nodes = append(nodes, cur)
				}
				cur.Children = parse()
				if pos > 0 && pos <= len(toks) {
					cur.End = toks[pos-1].end
				}
				cur = nil
			case cur == nil:
				cur = &Node{Key: t.s, Start: t.start, End: t.end}
				nodes = append(nodes, cur)
			default:
				cur.Args = append(cur.Args, t.s)
				cur.End = t.end
			}
		}
		return nodes
	}
	return parse()
}

// stripCommentsKeepOffsets blanks out comments with spaces so offsets still match the original text.
func stripCommentsKeepOffsets(text string) string {
	b := []byte(text)
	in := false
	for i := range b {
		switch {
		case b[i] == '\n':
			in = false
		case in:
			b[i] = ' '
		case b[i] == '#' || b[i] == '!':
			in = true
			b[i] = ' '
		}
	}
	return string(b)
}

func child(n *Node, key string) *Node {
	for _, c := range n.Children {
		if c.Key == key {
			return c
		}
	}
	return nil
}

func argInt(n *Node, key string) (int, bool) {
	c := child(n, key)
	if c == nil || len(c.Args) == 0 {
		return 0, false
	}
	v, err := strconv.Atoi(c.Args[0])
	return v, err == nil
}

func argString(n *Node, key string) string {
	if c := child(n, key); c != nil && len(c.Args) > 0 {
		return c.Args[0]
	}
	return ""
}

// Imported is an existing vrrp_instance, read for the migrate flow. Passwords are never read back.
type Imported struct {
	Instance
	HasPassword bool `json:"hasPassword"`
	// Unsupported lists settings KeepWatch does not manage, so the user knows they will be dropped.
	Unsupported []string `json:"unsupported"`
}

var supported = map[string]bool{
	"state": true, "interface": true, "virtual_router_id": true, "priority": true, "advert_int": true,
	"version": true, "nopreempt": true, "preempt_delay": true, "unicast_src_ip": true, "unicast_peer": true,
	"virtual_ipaddress": true, "authentication": true, "track_interface": true,
}

// Import reads the vrrp_instance blocks outside the KeepWatch block of keepalived.conf.
func Import(mainConf string) []Imported {
	out := []Imported{}
	for _, n := range Parse(outsideBlock(mainConf)) {
		if n.Key != "vrrp_instance" || len(n.Args) == 0 {
			continue
		}
		in := Imported{Instance: Instance{
			Name:            n.Args[0],
			State:           strings.ToUpper(argString(n, "state")),
			Interface:       argString(n, "interface"),
			VRRPVersion:     2,
			Preempt:         child(n, "nopreempt") == nil,
			UnicastPeers:    []string{},
			VirtualIPs:      []VirtualIP{},
			TrackInterfaces: []TrackInterface{},
			Checks:          []string{},
		}, Unsupported: []string{}}
		in.VRID, _ = argInt(n, "virtual_router_id")
		in.Priority, _ = argInt(n, "priority")
		in.AdvertInt, _ = argInt(n, "advert_int")
		in.PreemptDelay, _ = argInt(n, "preempt_delay")
		if v, ok := argInt(n, "version"); ok {
			in.VRRPVersion = v
		}
		in.UnicastSrcIP = argString(n, "unicast_src_ip")
		if peers := child(n, "unicast_peer"); peers != nil {
			for _, p := range peers.Children {
				in.UnicastPeers = append(in.UnicastPeers, p.Key)
			}
		}
		if vips := child(n, "virtual_ipaddress"); vips != nil {
			for _, v := range vips.Children {
				in.VirtualIPs = append(in.VirtualIPs, importVIP(v, in.Interface))
			}
		}
		if t := child(n, "track_interface"); t != nil {
			for _, c := range t.Children {
				ti := TrackInterface{Name: c.Key}
				if len(c.Args) == 2 && c.Args[0] == "weight" {
					ti.Weight, _ = strconv.Atoi(c.Args[1])
				}
				in.TrackInterfaces = append(in.TrackInterfaces, ti)
			}
		}
		in.HasPassword = child(n, "authentication") != nil
		for _, c := range n.Children {
			if !supported[c.Key] {
				in.Unsupported = append(in.Unsupported, c.Key)
			}
		}
		out = append(out, in)
	}
	return out
}

func importVIP(n *Node, iface string) VirtualIP {
	vip := VirtualIP{Address: n.Key}
	if p, err := netip.ParsePrefix(n.Key); err == nil {
		vip.Address = p.Addr().String()
		vip.Prefix = p.Bits()
	} else if a, err := netip.ParseAddr(n.Key); err == nil {
		vip.Prefix = 32
		if a.Is6() {
			vip.Prefix = 128
		}
	}
	for i := 0; i+1 < len(n.Args); i++ {
		if n.Args[i] == "dev" && n.Args[i+1] != iface {
			vip.Dev = n.Args[i+1]
		}
	}
	return vip
}

// CommentOut disables the named vrrp_instance blocks outside the KeepWatch block, line by line.
func CommentOut(mainConf string, names map[string]bool) string {
	before, inside, after, found := splitBlock(mainConf)
	if !found {
		before, after = mainConf, ""
	}
	disable := func(text string) string {
		type span struct{ start, end int }
		var spans []span
		for _, n := range Parse(text) {
			if n.Key == "vrrp_instance" && len(n.Args) > 0 && names[n.Args[0]] {
				spans = append(spans, span{n.Start, n.End})
			}
		}
		for i := len(spans) - 1; i >= 0; i-- {
			s := spans[i]
			start := strings.LastIndexByte(text[:s.start], '\n') + 1
			lines := strings.Split(text[start:s.end], "\n")
			for j, line := range lines {
				lines[j] = migratedMark + line
			}
			text = text[:start] + strings.Join(lines, "\n") + text[s.end:]
		}
		return text
	}
	return disable(before) + inside + disable(after)
}
