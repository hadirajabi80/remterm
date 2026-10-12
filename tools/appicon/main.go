// Command appicon draws the Termora icon and writes the Windows resources
// (icon, manifest, version info) as .syso files that `go build` links in.
//
//	go run ./tools/appicon
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

const appVersion = "0.1.0"

var sizes = []int{256, 128, 64, 48, 40, 32, 24, 20, 16}

func main() {
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
	writeResources(".", icon, "Termora", "Termora SSH workspace")
	writeResources("installer", icon, "TermoraSetup", "Termora Setup")
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
		version.ProductName:     "Termora",
		version.FileDescription: description,
		version.LegalCopyright:  "© Termora",
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

// render draws the icon at size px using supersampling for anti-aliasing.
func render(size int) image.Image {
	small := size <= 32
	margin := 0.055
	stroke := 0.088
	if small {
		margin, stroke = 0.02, 0.115
	}
	radius := 0.225

	// ">" chevron and "_" cursor, in unit coordinates.
	glyph := []seg{
		{0.285, 0.330, 0.465, 0.500},
		{0.465, 0.500, 0.285, 0.670},
		{0.535, 0.670, 0.725, 0.670},
	}
	if small { // nudge toward the pixel grid and widen for legibility
		glyph = []seg{
			{0.27, 0.31, 0.47, 0.50},
			{0.47, 0.50, 0.27, 0.69},
			{0.55, 0.69, 0.75, 0.69},
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
					for _, s := range glyph {
						if distToSeg(x, y, s) <= stroke/2 {
							col = glyphCol
							break
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
