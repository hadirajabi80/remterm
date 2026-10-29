package main

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestRdpDownloadChunks(t *testing.T) {
	target := filepath.Join(t.TempDir(), "result")
	m := newRdpDownloadManager()
	want := []byte{0, 1, 255, 10, 128, 42}
	id, err := m.begin(target, int64(len(want)))
	if err != nil {
		t.Fatal(err)
	}
	for _, chunk := range [][]byte{want[:2], want[2:5], want[5:]} {
		if err := m.write(id, base64.StdEncoding.EncodeToString(chunk)); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.finish(id); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}
func TestRdpDownloadEmptyAndLimits(t *testing.T) {
	m := newRdpDownloadManager()
	target := filepath.Join(t.TempDir(), "empty")
	id, err := m.begin(target, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.finish(id); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatal(err)
	}
	if _, err := m.begin(target, rdpDownloadMaxSize+1); err == nil {
		t.Fatal("expected size rejection")
	}
}
func TestRdpDownloadValidationCancel(t *testing.T) {
	m := newRdpDownloadManager()
	id, err := m.begin(filepath.Join(t.TempDir(), "file"), 2)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.write(id, "%%%not-base64"); err == nil {
		t.Fatal("expected malformed base64 rejection")
	}
	big := base64.StdEncoding.EncodeToString(make([]byte, rdpDownloadChunkMax+1))
	if err := m.write(id, big); err == nil {
		t.Fatal("expected chunk rejection")
	}
	if err := m.write(id, base64.StdEncoding.EncodeToString([]byte("abc"))); err == nil {
		t.Fatal("expected excess length rejection")
	}
	stage := m.items[id].stage
	if err := m.cancel(id); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stage); !os.IsNotExist(err) {
		t.Fatalf("staging file remains after cancel: %v", err)
	}
	if err := m.cancel(id); err != nil {
		t.Fatal(err)
	}
	if err := m.finish("unknown"); err == nil {
		t.Fatal("expected unknown id rejection")
	}
}
func TestRdpDownloadIncompleteFinish(t *testing.T) {
	m := newRdpDownloadManager()
	id, err := m.begin(filepath.Join(t.TempDir(), "partial"), 3)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.write(id, base64.StdEncoding.EncodeToString([]byte("ab"))); err != nil {
		t.Fatal(err)
	}
	if err := m.finish(id); err == nil {
		t.Fatal("expected incomplete rejection")
	}
	if err := m.write(id, base64.StdEncoding.EncodeToString([]byte("c"))); err != nil {
		t.Fatal(err)
	}
	if err := m.finish(id); err != nil {
		t.Fatal(err)
	}
}
func TestRdpDownloadFailedCommitPreservesDestination(t *testing.T) {
	target := filepath.Join(t.TempDir(), "existing")
	if err := os.WriteFile(target, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	m := newRdpDownloadManager()
	m.replace = func(string, string) error { return errors.New("simulated commit failure") }
	id, err := m.begin(target, 3)
	if err != nil {
		t.Fatal(err)
	}
	stage := m.items[id].stage
	if err := m.write(id, base64.StdEncoding.EncodeToString([]byte("new"))); err != nil {
		t.Fatal(err)
	}
	if err := m.finish(id); err == nil {
		t.Fatal("expected commit error")
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != "original" {
		t.Fatalf("existing destination changed: %q (%v)", got, err)
	}
	if _, err := os.Stat(stage); !os.IsNotExist(err) {
		t.Fatalf("staging file remains after failed commit: %v", err)
	}
}

func TestRdpDownloadShutdownCleansFiles(t *testing.T) {
	m := newRdpDownloadManager()
	dir := t.TempDir()
	id, err := m.begin(filepath.Join(dir, "dest"), 1)
	if err != nil {
		t.Fatal(err)
	}
	stage := m.items[id].stage
	m.close()
	if _, err := os.Stat(stage); !os.IsNotExist(err) {
		t.Fatalf("staging file remains: %v", err)
	}
	if _, err := m.begin(filepath.Join(dir, "new"), 0); !errors.Is(err, errRdpDownloadClosed) {
		t.Fatalf("expected closed error, got %v", err)
	}
}

func TestRdpDownloadSuccessfulOverwritePreservesBytes(t *testing.T) {
	target := filepath.Join(t.TempDir(), "existing.bin")
	if err := os.WriteFile(target, []byte("prior contents"), 0600); err != nil {
		t.Fatal(err)
	}
	want := []byte{0, 255, 1, 128, 65, 10}
	m := newRdpDownloadManager()
	id, err := m.begin(target, int64(len(want)))
	if err != nil {
		t.Fatal(err)
	}
	stage := m.items[id].stage
	if err := m.write(id, base64.StdEncoding.EncodeToString(want)); err != nil {
		t.Fatal(err)
	}
	if err := m.finish(id); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(want) {
		t.Fatalf("saved bytes = %v, want %v", got, want)
	}
	if _, err := os.Stat(stage); !os.IsNotExist(err) {
		t.Fatalf("staging file remains after commit: %v", err)
	}
}

func TestSafeDownloadName(t *testing.T) {
	slash := string([]byte{92})
	control := string([]byte{'b', 'a', 'd', 0, 'n', 'a', 'm', 'e'})
	cases := []struct{ name, want string }{
		{"C:" + slash + "Users" + slash + "user" + slash + "report.txt", "report.txt"},
		{"/home/user/report.txt", "report.txt"},
		{"資料" + slash + "文書.txt", "文書.txt"},
		{control, "badname"},
		{"  ", "download"},
	}
	for _, tc := range cases {
		if got := safeDownloadName(tc.name); got != tc.want {
			t.Errorf("safeDownloadName(%q)=%q, want %q", tc.name, got, tc.want)
		}
	}
}
