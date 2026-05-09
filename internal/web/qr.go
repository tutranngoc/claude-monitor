package web

import (
	"fmt"
	"io"
	"strings"

	"github.com/mdp/qrterminal/v3"
	"rsc.io/qr"
)

// PrintQR writes a QR-encoded version of url to w using half-block
// glyphs so the resulting code is dense enough to scan from a phone
// even on standard 80-col terminals. Errors from qrterminal are
// swallowed because failing to print a convenience QR shouldn't kill
// startup — the LAN URL gets printed alongside as a textual fallback.
func PrintQR(w io.Writer, url string) {
	// qr.L (low EC) is enough for short URLs and keeps the QR small;
	// half blocks pack two QR rows per terminal line so a typical
	// 30-byte URL fits in ~13 rows.
	qrterminal.GenerateHalfBlock(url, qr.L, w)
}

// WriteSVGQR encodes content as a QR and writes a stand-alone SVG to w.
// Used by the daemon's /api/lan/qr.svg endpoint so the browser can
// render the QR without us shipping a JS QR library. Errors only
// surface from io.Writer (or qr encoding); callers should treat the
// returned error as terminal — partial SVGs are not useful.
//
// The output is intentionally minimal: black-on-white squares in a
// fixed 8-wide cell, viewBox-driven so CSS can resize. No quiet zone
// because most CSS containers add their own padding.
func WriteSVGQR(w io.Writer, content string) error {
	code, err := qr.Encode(content, qr.L)
	if err != nil {
		return fmt.Errorf("encode qr: %w", err)
	}
	const cell = 8
	size := code.Size
	dim := size * cell
	var b strings.Builder
	fmt.Fprintf(&b,
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges">`,
		dim, dim,
	)
	b.WriteString(`<rect width="100%" height="100%" fill="#fff"/>`)
	// One <path> with merged horizontal runs is ~10x smaller than
	// emitting one <rect> per black cell. Each row scans left→right
	// and accumulates contiguous blacks into a single "M…h…" segment.
	b.WriteString(`<path fill="#000" d="`)
	for y := 0; y < size; y++ {
		x := 0
		for x < size {
			if !code.Black(x, y) {
				x++
				continue
			}
			runStart := x
			for x < size && code.Black(x, y) {
				x++
			}
			runLen := x - runStart
			fmt.Fprintf(&b, "M%d %dh%dv%dh-%dz",
				runStart*cell, y*cell, runLen*cell, cell, runLen*cell,
			)
		}
	}
	b.WriteString(`"/></svg>`)
	_, err = io.WriteString(w, b.String())
	return err
}
