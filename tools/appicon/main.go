// Command appicon draws the Remterm icon and writes the Windows resources
// (icon, manifest, version info) as .syso files that `go build` links in.
//
//	go run ./tools/appicon [version]
//
// Each icon size is rendered from the vector description directly instead of
// being downscaled, so the 16–32 px variants stay sharp.
package main

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"

	"github.com/tc-hib/winres"
	"github.com/tc-hib/winres/version"
)

var appVersion = "1.0.0" // overridden by the first argument

var sizes = []int{256, 128, 64, 48, 40, 32, 24, 20, 16}

func main() {
	if len(os.Args) > 1 {
		appVersion = os.Args[1]
	}
	var images []image.Image
	for _, s := range sizes {
		images = append(images, render(s))
	}

	must(os.MkdirAll(filepath.Join("build", "windows"), 0o755))
	must(writePNG(filepath.Join("build", "appicon.png"), render(1024)))

	icon, err := winres.NewIconFromImages(images)
	must(err)
	f, err := os.Create(filepath.Join("build", "windows", "icon.ico"))
	must(err)
	must(icon.SaveICO(f))
	must(f.Close())

	// The app, and the installer (separate exe with its own description).
	writeResources(".", icon, "Remterm", "Remterm - SSH, Remote Desktop and terminals")
	writeResources("installer", icon, "RemtermSetup", "Remterm Setup")
	fmt.Println("wrote rsrc_windows_*.syso (app + installer), build/windows/icon.ico, build/appicon.png")
}

// writeResources writes icon (ID 3, where Wails looks), manifest and
// version info as .syso files into dir, for amd64 and arm64.
func writeResources(dir string, icon *winres.Icon, name, description string) {
	rs := winres.ResourceSet{}
	must(rs.SetIcon(winres.ID(3), icon))
	// asInvoker also stops Windows' "installer detection" from asking for
	// admin rights just because the file name contains "Setup".
	rs.SetManifest(winres.AppManifest{
		Identity:            winres.AssemblyIdentity{Name: name, Version: [4]uint16{0, 1, 0, 0}},
		Description:         description,
		ExecutionLevel:      winres.AsInvoker,
		DPIAwareness:        winres.DPIPerMonitorV2,
		UseCommonControlsV6: true,
		LongPathAware:       true,
	})

	var vi version.Info
	vi.SetFileVersion(appVersion)
	vi.SetProductVersion(appVersion)
	for k, v := range map[string]string{
		version.ProductName:     "Remterm",
		version.FileDescription: description,
		version.LegalCopyright:  "© Remterm",
	} {
		must(vi.Set(version.LangDefault, k, v))
	}
	rs.SetVersionInfo(vi)

	for file, arch := range map[string]winres.Arch{
		"rsrc_windows_amd64.syso": winres.ArchAMD64,
		"rsrc_windows_arm64.syso": winres.ArchARM64,
	} {
		out, err := os.Create(filepath.Join(dir, file))
		must(err)
		must(rs.WriteObject(out, arch))
		must(out.Close())
	}
}

// ---- drawing ----

var (
	gradFrom  = rgb(0x7a, 0xa2, 0xf7) // matches the sidebar logo
	gradTo    = rgb(0xbb, 0x9a, 0xf7)
	glyphCol  = rgb(0x0d, 0x11, 0x17)
	edgeLight = 0.18 // top highlight strength
)

type fcolor struct{ r, g, b float64 }

func rgb(r, g, b uint8) fcolor { return fcolor{float64(r) / 255, float64(g) / 255, float64(b) / 255} }

func mix(a, b fcolor, t float64) fcolor {
	return fcolor{a.r + (b.r-a.r)*t, a.g + (b.g-a.g)*t, a.b + (b.b-a.b)*t}
}

type seg struct{ ax, ay, bx, by float64 }

// render draws the icon at size px using supersampling for anti-aliasing:
// a monitor (Remote Desktop) showing a ">_" prompt (terminal).
func render(size int) image.Image {
	small := size <= 32
	margin := 0.055
	stroke, glyphStroke := 0.062, 0.072
	if small {
		margin, stroke, glyphStroke = 0.02, 0.09, 0.1
	}
	radius := 0.225

	// Screen outline (rounded rectangle) in unit coordinates.
	scx, scy, shw, shh, sr := 0.5, 0.445, 0.30, 0.215, 0.07
	glyph := []seg{
		{0.335, 0.355, 0.445, 0.445}, // ">"
		{0.445, 0.445, 0.335, 0.535},
		{0.495, 0.535, 0.635, 0.535}, // "_"
		{0.5, 0.66, 0.5, 0.75},       // stand
		{0.375, 0.775, 0.625, 0.775}, // base
	}
	if small { // bigger and on the pixel grid for legibility
		scx, scy, shw, shh, sr = 0.5, 0.43, 0.34, 0.25, 0.06
		glyph = []seg{
			{0.31, 0.33, 0.46, 0.445},
			{0.46, 0.445, 0.31, 0.56},
			{0.52, 0.56, 0.69, 0.56},
			{0.5, 0.68, 0.5, 0.79},
			{0.33, 0.8, 0.67, 0.8},
		}
	}

	ss := 4
	if size <= 64 {
		ss = 8
	}
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	lo, hi := margin, 1-margin
	half := (hi - lo) / 2
	c := 0.5
	r := radius * (hi - lo)

	for py := 0; py < size; py++ {
		for px := 0; px < size; px++ {
			var ar, ag, ab, aa float64
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					x := (float64(px) + (float64(sx)+0.5)/float64(ss)) / float64(size)
					y := (float64(py) + (float64(sy)+0.5)/float64(ss)) / float64(size)

					dx := math.Max(math.Abs(x-c)-(half-r), 0)
					dy := math.Max(math.Abs(y-c)-(half-r), 0)
					if dx*dx+dy*dy > r*r {
						continue
					}
					t := ((x - lo) + (y - lo)) / (2 * (hi - lo))
					col := mix(gradFrom, gradTo, t)
					// soft light from the top edge
					if h := 1 - (y-lo)/(hi-lo)/0.5; h > 0 {
						col = mix(col, fcolor{1, 1, 1}, edgeLight*h*h)
					}
					if math.Abs(roundRectDist(x, y, scx, scy, shw, shh, sr)) <= stroke/2 {
						col = glyphCol
					} else {
						for _, s := range glyph {
							if distToSeg(x, y, s) <= glyphStroke/2 {
								col = glyphCol
								break
							}
						}
					}
					ar += col.r
					ag += col.g
					ab += col.b
					aa++
				}
			}
			if aa == 0 {
				continue
			}
			n := float64(ss * ss)
			img.SetNRGBA(px, py, color.NRGBA{
				R: uint8(math.Round(ar / aa * 255)),
				G: uint8(math.Round(ag / aa * 255)),
				B: uint8(math.Round(ab / aa * 255)),
				A: uint8(math.Round(aa / n * 255)),
			})
		}
	}
	return img
}

// roundRectDist is the signed distance from (x, y) to a rounded rectangle
// centred at (cx, cy) with half extents hw, hh and corner radius r.
func roundRectDist(x, y, cx, cy, hw, hh, r float64) float64 {
	qx := math.Abs(x-cx) - hw + r
	qy := math.Abs(y-cy) - hh + r
	outside := math.Hypot(math.Max(qx, 0), math.Max(qy, 0))
	return outside + math.Min(math.Max(qx, qy), 0) - r
}
func distToSeg(x, y float64, s seg) float64 {
	vx, vy := s.bx-s.ax, s.by-s.ay
	wx, wy := x-s.ax, y-s.ay
	t := math.Max(0, math.Min(1, (wx*vx+wy*vy)/(vx*vx+vy*vy)))
	return math.Hypot(wx-t*vx, wy-t*vy)
}

func writePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
