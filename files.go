package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
)

// FileEntry is one row in a file pane.
type FileEntry struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Dir      bool   `json:"dir"`
	Link     bool   `json:"link"`
	Size     int64  `json:"size"`
	Mode     string `json:"mode"` // drwxr-xr-x
	Perm     uint32 `json:"perm"`
	Modified int64  `json:"modified"` // unix ms
}

// fileSystem is the local disk or an SFTP server, so panes and transfers
// treat both the same way.
type fileSystem interface {
	Home() string
	List(dir string) ([]FileEntry, error)
	Stat(p string) (fs.FileInfo, error)
	Open(p string) (io.ReadCloser, error)
	Create(p string) (io.WriteCloser, error)
	Mkdir(p string) error
	Rename(from, to string) error
	RemoveAll(p string) error
	Chmod(p string, mode fs.FileMode) error
	Join(elem ...string) string
	Base(p string) string
}

func entryFrom(fsys fileSystem, dir string, fi fs.FileInfo) FileEntry {
	return FileEntry{
		Name:     fi.Name(),
		Path:     fsys.Join(dir, fi.Name()),
		Dir:      fi.IsDir(),
		Link:     fi.Mode()&fs.ModeSymlink != 0,
		Size:     fi.Size(),
		Mode:     fi.Mode().String(),
		Perm:     uint32(fi.Mode().Perm()),
		Modified: fi.ModTime().UnixMilli(),
	}
}

// ---- local ----

type localFS struct{}

func (localFS) Home() string { h, _ := os.UserHomeDir(); return h }
func (localFS) Join(elem ...string) string {
	if len(elem) > 0 && elem[0] == "" { // drive list → "C:\"
		return filepath.Join(elem[1:]...) + `\`
	}
	return filepath.Join(elem...)
}
func (localFS) Base(p string) string                    { return filepath.Base(p) }
func (localFS) Stat(p string) (fs.FileInfo, error)      { return os.Stat(p) }
func (localFS) Open(p string) (io.ReadCloser, error)    { return os.Open(p) }
func (localFS) Create(p string) (io.WriteCloser, error) { return os.Create(p) }
func (localFS) Mkdir(p string) error                    { return os.Mkdir(p, 0o755) }
func (localFS) Rename(a, b string) error                { return os.Rename(a, b) }
func (localFS) RemoveAll(p string) error                { return os.RemoveAll(p) }
func (localFS) Chmod(p string, m fs.FileMode) error     { return os.Chmod(p, m) }

func (l localFS) List(dir string) ([]FileEntry, error) {
	if dir == "" && runtime.GOOS == "windows" {
		var out []FileEntry
		for c := 'A'; c <= 'Z'; c++ {
			root := string(c) + `:\`
			if _, err := os.Stat(root); err == nil {
				out = append(out, FileEntry{Name: string(c) + ":", Path: root, Dir: true, Mode: "drive"})
			}
		}
		return out, nil
	}
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]FileEntry, 0, len(ents))
	for _, e := range ents {
		fi, err := e.Info()
		if err != nil {
			continue
		}
		fe := entryFrom(l, dir, fi)
		if fe.Link {
			if t, err := os.Stat(fe.Path); err == nil {
				fe.Dir = t.IsDir()
			}
		}
		out = append(out, fe)
	}
	return out, nil
}

// ---- SFTP ----

type remoteFS struct {
	c    *sftp.Client
	home string
}

func (r *remoteFS) Home() string                         { return r.home }
func (r *remoteFS) Join(elem ...string) string           { return path.Join(elem...) }
func (r *remoteFS) Base(p string) string                 { return path.Base(p) }
func (r *remoteFS) Stat(p string) (fs.FileInfo, error)   { return r.c.Stat(p) }
func (r *remoteFS) Open(p string) (io.ReadCloser, error) { return r.c.Open(p) }
func (r *remoteFS) Create(p string) (io.WriteCloser, error) {
	return r.c.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
}
func (r *remoteFS) Mkdir(p string) error                { return r.c.Mkdir(p) }
func (r *remoteFS) Rename(a, b string) error            { return r.c.PosixRename(a, b) }
func (r *remoteFS) RemoveAll(p string) error            { return r.c.RemoveAll(p) }
func (r *remoteFS) Chmod(p string, m fs.FileMode) error { return r.c.Chmod(p, m) }

func (r *remoteFS) List(dir string) ([]FileEntry, error) {
	if dir == "" {
		dir = r.home
	}
	infos, err := r.c.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	out := make([]FileEntry, 0, len(infos))
	for _, fi := range infos {
		fe := entryFrom(r, dir, fi)
		if fe.Link {
			if t, err := r.c.Stat(fe.Path); err == nil {
				fe.Dir = t.IsDir()
			}
		}
		out = append(out, fe)
	}
	return out, nil
}

// ---- sessions ----

type fileSession struct {
	fs   fileSystem
	conn *sshConn
	sftp *sftp.Client
}

type fileManager struct {
	mu        sync.Mutex
	sessions  map[string]*fileSession
	transfers map[string]context.CancelFunc
}

const localFSID = "local"

func (a *App) fsGet(id string) (fileSystem, error) {
	if id == localFSID {
		return localFS{}, nil
	}
	a.files.mu.Lock()
	defer a.files.mu.Unlock()
	s := a.files.sessions[id]
	if s == nil {
		return nil, errors.New("SFTP session closed — reconnect")
	}
	return s.fs, nil
}

type SftpRequest struct {
	SessionID    string `json:"sessionId"`
	HostID       string `json:"hostId"`
	Password     string `json:"password"`
	SavePassword bool   `json:"savePassword"`
}

// OpenSftp connects to a host's SFTP subsystem and returns the start folder.
func (a *App) OpenSftp(req SftpRequest) (string, error) {
	h, ok := a.store.Host(req.HostID)
	if !ok {
		return "", errors.New("host not found")
	}
	conn, err := a.connectHost(h, req.Password, nil)
	if err != nil {
		return "", err
	}
	c, err := sftp.NewClient(conn.client)
	if err != nil {
		conn.Close()
		return "", fmt.Errorf("SFTP is not available on this server: %w", err)
	}
	home, err := c.Getwd()
	if err != nil || home == "" {
		home = "/"
	}
	a.rememberConnection(h, req.Password, req.SavePassword)
	a.files.mu.Lock()
	a.files.sessions[req.SessionID] = &fileSession{fs: &remoteFS{c: c, home: home}, conn: conn, sftp: c}
	a.files.mu.Unlock()
	go func() { // tell the pane when the connection drops
		_ = conn.client.Wait()
		a.files.mu.Lock()
		_, open := a.files.sessions[req.SessionID]
		delete(a.files.sessions, req.SessionID)
		a.files.mu.Unlock()
		if open {
			a.emit("fs:closed", req.SessionID)
		}
	}()
	return home, nil
}

func (a *App) CloseSftp(id string) {
	a.files.mu.Lock()
	s := a.files.sessions[id]
	delete(a.files.sessions, id)
	a.files.mu.Unlock()
	if s != nil {
		s.sftp.Close()
		s.conn.Close()
	}
}

func (a *App) FsHome(id string) (string, error) {
	f, err := a.fsGet(id)
	if err != nil {
		return "", err
	}
	return f.Home(), nil
}

func (a *App) FsList(id, dir string) ([]FileEntry, error) {
	f, err := a.fsGet(id)
	if err != nil {
		return nil, err
	}
	out, err := f.List(dir)
	if err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Dir != out[j].Dir {
			return out[i].Dir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

// FsParent returns the parent folder ("" for the local drive list).
func (a *App) FsParent(id, p string) string {
	if id == localFSID {
		parent := filepath.Dir(p)
		if parent == p { // C:\ → drive list
			return ""
		}
		return parent
	}
	return path.Dir(p)
}

func (a *App) FsMkdir(id, p string) error {
	f, err := a.fsGet(id)
	if err != nil {
		return err
	}
	return f.Mkdir(p)
}

func (a *App) FsRename(id, from, to string) error {
	f, err := a.fsGet(id)
	if err != nil {
		return err
	}
	return f.Rename(from, to)
}

func (a *App) FsDelete(id string, paths []string) error {
	f, err := a.fsGet(id)
	if err != nil {
		return err
	}
	for _, p := range paths {
		if err := f.RemoveAll(p); err != nil {
			return fmt.Errorf("%s: %w", f.Base(p), err)
		}
	}
	return nil
}

func (a *App) FsChmod(id, p string, perm uint32) error {
	f, err := a.fsGet(id)
	if err != nil {
		return err
	}
	return f.Chmod(p, fs.FileMode(perm&0o7777))
}

// ---- transfers ----

type TransferRequest struct {
	SrcFS  string   `json:"srcFs"`
	Paths  []string `json:"paths"`
	DstFS  string   `json:"dstFs"`
	DstDir string   `json:"dstDir"`
}

type TransferProgress struct {
	ID         string `json:"id"`
	State      string `json:"state"` // running | done | error | canceled
	Label      string `json:"label"`
	File       string `json:"file"`
	FilesDone  int    `json:"filesDone"`
	FilesTotal int    `json:"filesTotal"`
	BytesDone  int64  `json:"bytesDone"`
	BytesTotal int64  `json:"bytesTotal"`
	Error      string `json:"error"`
}

// FsTransfer copies files/folders between any two file systems (local ↔
// remote or remote ↔ remote, streamed directly). Existing files are
// overwritten. Progress arrives as "fs:transfer" events.
func (a *App) FsTransfer(req TransferRequest) (string, error) {
	src, err := a.fsGet(req.SrcFS)
	if err != nil {
		return "", err
	}
	dst, err := a.fsGet(req.DstFS)
	if err != nil {
		return "", err
	}
	if len(req.Paths) == 0 {
		return "", errors.New("nothing to copy")
	}
	id := newID()
	ctx, cancel := context.WithCancel(context.Background())
	a.files.mu.Lock()
	a.files.transfers[id] = cancel
	a.files.mu.Unlock()

	label := src.Base(req.Paths[0])
	if len(req.Paths) > 1 {
		label = fmt.Sprintf("%d items", len(req.Paths))
	}
	go func() {
		defer func() {
			a.files.mu.Lock()
			delete(a.files.transfers, id)
			a.files.mu.Unlock()
			cancel()
		}()
		p := TransferProgress{ID: id, State: "running", Label: label}
		for _, sp := range req.Paths { // size up front for a real progress bar
			countTree(src, sp, &p)
		}
		emit := func() { a.emit("fs:transfer", p) }
		emit()
		last := time.Now()
		tick := func() {
			if time.Since(last) > 120*time.Millisecond {
				last = time.Now()
				emit()
			}
		}
		var err error
		for _, sp := range req.Paths {
			if err = copyTree(ctx, src, sp, dst, dst.Join(req.DstDir, src.Base(sp)), &p, tick); err != nil {
				break
			}
		}
		switch {
		case ctx.Err() != nil:
			p.State = "canceled"
		case err != nil:
			p.State, p.Error = "error", err.Error()
		default:
			p.State = "done"
		}
		emit()
	}()
	return id, nil
}

func (a *App) CancelTransfer(id string) {
	a.files.mu.Lock()
	cancel := a.files.transfers[id]
	a.files.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func countTree(f fileSystem, p string, prog *TransferProgress) {
	fi, err := f.Stat(p)
	if err != nil {
		return
	}
	if !fi.IsDir() {
		prog.FilesTotal++
		prog.BytesTotal += fi.Size()
		return
	}
	ents, err := f.List(p)
	if err != nil {
		return
	}
	for _, e := range ents {
		countTree(f, e.Path, prog)
	}
}

func copyTree(ctx context.Context, src fileSystem, sp string, dst fileSystem, dp string, prog *TransferProgress, tick func()) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	fi, err := src.Stat(sp)
	if err != nil {
		return err
	}
	if fi.IsDir() {
		if err := dst.Mkdir(dp); err != nil {
			if st, serr := dst.Stat(dp); serr != nil || !st.IsDir() {
				return fmt.Errorf("create folder %s: %w", dp, err)
			}
		}
		ents, err := src.List(sp)
		if err != nil {
			return err
		}
		for _, e := range ents {
			if err := copyTree(ctx, src, e.Path, dst, dst.Join(dp, e.Name), prog, tick); err != nil {
				return err
			}
		}
		return nil
	}
	prog.File = src.Base(sp)
	in, err := src.Open(sp)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := dst.Create(dp)
	if err != nil {
		return fmt.Errorf("write %s: %w", dp, err)
	}
	buf := make([]byte, 256*1024)
	for {
		if ctx.Err() != nil {
			out.Close()
			return ctx.Err()
		}
		n, rerr := in.Read(buf)
		if n > 0 {
			if _, werr := out.Write(buf[:n]); werr != nil {
				out.Close()
				return werr
			}
			prog.BytesDone += int64(n)
			tick()
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			out.Close()
			return rerr
		}
	}
	if err := out.Close(); err != nil {
		return err
	}
	// Keep permissions between servers only: Windows reports 0666 for every file.
	if _, ok := src.(*remoteFS); ok {
		if _, ok := dst.(*remoteFS); ok {
			_ = dst.Chmod(dp, fi.Mode().Perm())
		}
	}
	prog.FilesDone++
	tick()
	return nil
}

// ---- open / edit ----

// FsOpen opens a file with its default Windows app. Remote files are
// downloaded to a temp folder first and uploaded back automatically every
// time they are saved ("fs:edited" events), while the SFTP pane is open.
func (a *App) FsOpen(id, p string) error {
	if id == localFSID {
		return openWithDefaultApp(p)
	}
	f, err := a.fsGet(id)
	if err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "remterm-edit-")
	if err != nil {
		return err
	}
	local := filepath.Join(dir, f.Base(p))
	if err := copyTree(context.Background(), f, p, localFS{}, local, &TransferProgress{}, func() {}); err != nil {
		return err
	}
	st, err := os.Stat(local)
	if err != nil {
		return err
	}
	if err := openWithDefaultApp(local); err != nil {
		return err
	}
	go a.watchEdit(id, p, local, st.ModTime())
	return nil
}

func (a *App) watchEdit(id, remote, local string, mod time.Time) {
	defer os.RemoveAll(filepath.Dir(local))
	deadline := time.Now().Add(12 * time.Hour)
	for time.Now().Before(deadline) {
		time.Sleep(time.Second)
		f, err := a.fsGet(id)
		if err != nil {
			return // pane closed
		}
		st, err := os.Stat(local)
		if err != nil || !st.ModTime().After(mod) {
			continue
		}
		mod = st.ModTime()
		time.Sleep(300 * time.Millisecond) // let the editor finish writing
		err = copyTree(context.Background(), localFS{}, local, f, remote, &TransferProgress{}, func() {})
		msg := ""
		if err != nil {
			msg = err.Error()
		}
		a.emit("fs:edited", id, remote, msg)
	}
}
