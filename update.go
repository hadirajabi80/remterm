package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// Updates come from the GitHub releases of the project: the app checks the
// latest release, downloads the file for this system (the Windows setup or
// the macOS .dmg) and installs it (update_windows.go / update_darwin.go).

// appVersion is set at build time: -ldflags "-X main.appVersion=1.2.1".
var appVersion = "dev"

const releasesAPI = "https://api.github.com/repos/hadirajabi80/remterm/releases/latest"

type UpdateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Available bool   `json:"available"`
	Newer     bool   `json:"newer"` // a newer release exists, even if its file for this system is not attached yet
	Notes     string `json:"notes"`
	Page      string `json:"page"`  // release page
	Asset     string `json:"asset"` // file for this system
	URL       string `json:"url"`
	Size      int64  `json:"size"`
	Digest    string `json:"digest"` // "sha256:<hex>" when GitHub publishes one
}

func (a *App) AppVersion() string { return appVersion }

// CheckUpdate asks GitHub for the latest release.
func (a *App) CheckUpdate() (UpdateInfo, error) {
	info := UpdateInfo{Current: appVersion}
	req, _ := http.NewRequest("GET", releasesAPI, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Remterm/"+appVersion)
	c := &http.Client{Timeout: 20 * time.Second}
	res, err := c.Do(req)
	if err != nil {
		return info, fmt.Errorf("could not reach GitHub: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return info, fmt.Errorf("GitHub answered %s", res.Status)
	}
	var rel struct {
		TagName string `json:"tag_name"`
		Body    string `json:"body"`
		HTMLURL string `json:"html_url"`
		Assets  []struct {
			Name   string `json:"name"`
			URL    string `json:"browser_download_url"`
			Size   int64  `json:"size"`
			Digest string `json:"digest"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(res.Body).Decode(&rel); err != nil {
		return info, err
	}
	info.Latest = strings.TrimPrefix(rel.TagName, "v")
	info.Notes = rel.Body
	info.Page = rel.HTMLURL
	want := updateAssetPattern()
	for _, as := range rel.Assets {
		if want != nil && want.MatchString(as.Name) {
			info.Asset, info.URL, info.Size, info.Digest = as.Name, as.URL, as.Size, as.Digest
		}
	}
	info.Newer = appVersion != "dev" && want != nil && newerVersion(info.Latest, appVersion)
	info.Available = info.URL != "" && info.Newer
	return info, nil
}

func updateAssetPattern() *regexp.Regexp {
	switch runtime.GOOS {
	case "windows":
		return regexp.MustCompile(`^RemtermSetup-[\d.]+\.exe$`)
	case "darwin":
		return regexp.MustCompile(`^Remterm-[\d.]+-macOS\.dmg$`)
	}
	return nil
}

// newerVersion compares dotted versions: 1.10.0 > 1.9.3.
func newerVersion(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x = leadingInt(pa[i])
		}
		if i < len(pb) {
			y = leadingInt(pb[i])
		}
		if x != y {
			return x > y
		}
	}
	return false
}

// leadingInt reads the number a version part starts with: "1-hotfix" is 1.
func leadingInt(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// updateClient downloads updates; download's watchdog cuts a stalled transfer.
var updateClient = &http.Client{Transport: &http.Transport{
	Proxy:                 http.ProxyFromEnvironment,
	DialContext:           (&net.Dialer{Timeout: 15 * time.Second}).DialContext,
	TLSHandshakeTimeout:   15 * time.Second,
	ResponseHeaderTimeout: 30 * time.Second,
}}

// InstallUpdate downloads the latest release for this system, installs it and restarts Remterm.
// Progress goes to the UI as "update:progress" events (0–100).
func (a *App) InstallUpdate() error {
	info, err := a.CheckUpdate()
	if err != nil {
		return err
	}
	if !info.Available {
		return errors.New("Remterm is up to date")
	}
	dir, err := os.MkdirTemp("", "remterm-update-")
	if err != nil {
		return err
	}
	file := filepath.Join(dir, info.Asset)
	if err := a.download(info.URL, file, info.Size, info.Digest); err != nil {
		_ = os.RemoveAll(dir)
		return fmt.Errorf("download %s: %w", info.Asset, err)
	}
	a.emit("update:progress", 100, "Installing…")
	if err := a.installUpdate(file); err != nil {
		_ = os.RemoveAll(dir)
		return err
	}
	return nil // the setup runs from dir: keep it
}

func (a *App) download(url, path string, size int64, digest string) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	const idle = 45 * time.Second
	stall := time.AfterFunc(idle, cancel) // no data for this long: give up
	defer stall.Stop()
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Remterm/"+appVersion)
	res, err := updateClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return errors.New("download stalled")
		}
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return errors.New(res.Status)
	}
	if size <= 0 {
		size = res.ContentLength
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	w := io.MultiWriter(f, h)
	buf := make([]byte, 256<<10)
	var done int64
	last := -1
	for {
		n, err := res.Body.Read(buf)
		if n > 0 {
			stall.Reset(idle)
			if _, werr := w.Write(buf[:n]); werr != nil {
				return werr
			}
			done += int64(n)
			if size > 0 {
				if pct := int(done * 100 / size); pct != last {
					last = pct
					a.emit("update:progress", pct, "Downloading…")
				}
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			if ctx.Err() != nil {
				return errors.New("download stalled")
			}
			return err
		}
	}
	if size > 0 && done != size {
		return fmt.Errorf("incomplete download (%d of %d bytes)", done, size)
	}
	if want, ok := strings.CutPrefix(digest, "sha256:"); ok && !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), want) {
		return fmt.Errorf("checksum mismatch for %s", filepath.Base(path))
	}
	return nil
}
