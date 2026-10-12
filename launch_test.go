package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCwdFromArgs(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		args []string
		want string
	}{
		{nil, ""},
		{[]string{"--cwd", dir}, dir},
		{[]string{"--cwd=" + dir}, dir},
		{[]string{`--cwd`, `"` + dir + `"`}, dir}, // quoted, as Explorer may pass it
		{[]string{dir}, dir},                    // bare folder (drag onto exe)
		{[]string{"--cwd", file}, dir},          // a file opens its folder
		{[]string{"--cwd", filepath.Join(dir, "missing")}, ""},
	}
	for _, c := range cases {
		if got := cwdFromArgs(c.args); got != c.want {
			t.Errorf("cwdFromArgs(%q) = %q, want %q", c.args, got, c.want)
		}
	}
}

func TestRecordable(t *testing.T) {
	for cmd, want := range map[string]bool{
		"docker compose ps":                   true,
		"":                                    false,
		" secret-command":                     false, // leading space = don't record
		"mysql --password=hunter2":            false,
		"export API_KEY=abc123":               false,
		"curl -H 'token: abc' https://x":      false,
		"psql -U app --password secret":       false,
		"git log --oneline":                   true,
		"echo password reset flow is done ok": true,
	} {
		if got := recordable(cmd); got != want {
			t.Errorf("recordable(%q) = %v, want %v", cmd, got, want)
		}
	}
}
