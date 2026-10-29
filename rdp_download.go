package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	rdpDownloadMaxSize         = int64(256 << 20)
	rdpDownloadChunkMax        = 256 << 10
	rdpDownloadChunkEncodedMax = ((rdpDownloadChunkMax + 2) / 3) * 4
)

var (
	errRdpDownloadClosed = errors.New("Remote Desktop downloads are closing")
	errRdpDownloadSize   = errors.New("file size must be between 0 and 256 MiB")
)

type rdpDownload struct {
	target string
	stage  string
	file   *os.File
	size   int64
	wrote  int64
}

type rdpDownloadManager struct {
	mu      sync.Mutex
	closed  bool
	items   map[string]*rdpDownload
	replace func(source, destination string) error
}

func newRdpDownloadManager() *rdpDownloadManager {
	return &rdpDownloadManager{items: map[string]*rdpDownload{}}
}

// begin is the non-dialog core: destination is the user's selected path.
func (m *rdpDownloadManager) begin(destination string, size int64) (string, error) {
	if size < 0 || size > rdpDownloadMaxSize {
		return "", errRdpDownloadSize
	}
	if strings.TrimSpace(destination) == "" {
		return "", errors.New("a destination is required")
	}
	target, err := filepath.Abs(destination)
	if err != nil {
		return "", fmt.Errorf("resolve download destination: %w", err)
	}
	parent := filepath.Dir(target)
	base := filepath.Base(target)
	if base == "." || base == string(filepath.Separator) || base == "" {
		return "", errors.New("a file destination is required")
	}
	stage, err := os.CreateTemp(parent, ".remterm-download-*")
	if err != nil {
		return "", fmt.Errorf("create download staging file: %w", err)
	}
	id := newID()
	d := &rdpDownload{target: target, stage: stage.Name(), file: stage, size: size}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		stage.Close()
		os.Remove(stage.Name())
		return "", errRdpDownloadClosed
	}
	if m.items == nil {
		m.items = map[string]*rdpDownload{}
	}
	m.items[id] = d
	return id, nil
}

func (m *rdpDownloadManager) write(id, chunkBase64 string) error {
	if len(chunkBase64) > rdpDownloadChunkEncodedMax {
		return errors.New("download chunk exceeds the 256 KiB limit")
	}
	data, err := base64.StdEncoding.DecodeString(chunkBase64)
	if err != nil {
		return fmt.Errorf("invalid download chunk: %w", err)
	}
	if len(data) > rdpDownloadChunkMax {
		return errors.New("download chunk exceeds the 256 KiB limit")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.items[id]
	if d == nil {
		return errors.New("unknown or finished Remote Desktop download")
	}
	if d.wrote+int64(len(data)) > d.size {
		return errors.New("download contains more bytes than expected")
	}
	if len(data) != 0 {
		n, err := d.file.Write(data)
		d.wrote += int64(n)
		if err != nil {
			return fmt.Errorf("write download staging file: %w", err)
		}
		if n != len(data) {
			return errors.New("short write to download staging file")
		}
	}
	return nil
}

func (m *rdpDownloadManager) finish(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.items[id]
	if d == nil {
		return errors.New("unknown or finished Remote Desktop download")
	}
	if d.wrote != d.size {
		return fmt.Errorf("download is incomplete: received %d of %d bytes", d.wrote, d.size)
	}
	if err := d.file.Sync(); err != nil {
		m.discardLocked(id, d)
		return fmt.Errorf("flush download: %w", err)
	}
	if err := d.file.Close(); err != nil {
		m.discardLocked(id, d)
		return fmt.Errorf("close download: %w", err)
	}
	d.file = nil
	replace := m.replace
	if replace == nil {
		replace = replaceFile
	}
	if err := replace(d.stage, d.target); err != nil {
		m.discardLocked(id, d)
		return fmt.Errorf("save download: %w", err)
	}
	delete(m.items, id)
	return nil
}

func (m *rdpDownloadManager) cancel(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if d := m.items[id]; d != nil {
		m.discardLocked(id, d)
	}
	return nil // cancellation is intentionally idempotent
}

func (m *rdpDownloadManager) close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	for id, d := range m.items {
		m.discardLocked(id, d)
	}
}

func (m *rdpDownloadManager) discardLocked(id string, d *rdpDownload) {
	delete(m.items, id)
	if d.file != nil {
		_ = d.file.Close()
		d.file = nil
	}
	_ = os.Remove(d.stage)
}

// RdpDownloadBegin asks where to save the file; an empty path means the user canceled.
func (a *App) RdpDownloadBegin(name string, size int64) (string, error) {
	if size < 0 || size > rdpDownloadMaxSize {
		return "", errRdpDownloadSize
	}
	opts := wruntime.SaveDialogOptions{Title: "Save Remote Desktop file", DefaultFilename: safeDownloadName(name)}
	destination, err := wruntime.SaveFileDialog(a.ctx, opts)
	if err != nil {
		return "", err
	}
	if destination == "" {
		return "", nil
	}
	return a.rdpDownloads.begin(destination, size)
}

// RdpDownloadWrite appends one ordered base64-encoded file chunk to its staging file.
func (a *App) RdpDownloadWrite(id, chunkBase64 string) error {
	return a.rdpDownloads.write(id, chunkBase64)
}

// RdpDownloadFinish commits a complete download to its selected destination.
func (a *App) RdpDownloadFinish(id string) error { return a.rdpDownloads.finish(id) }

// RdpDownloadCancel discards a partial download. Repeated cancellation is safe.
func (a *App) RdpDownloadCancel(id string) error { return a.rdpDownloads.cancel(id) }

func safeDownloadName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = filepath.Base(name)
	name = strings.TrimSpace(name)
	var b strings.Builder
	for _, r := range name {
		if r == '/' || r == '\\' || unicode.IsControl(r) {
			continue
		}
		b.WriteRune(r)
	}
	name = strings.TrimSpace(b.String())
	if name == "" || name == "." || name == ".." {
		return "download"
	}
	return name
}
