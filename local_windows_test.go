//go:build windows

package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/UserExistsError/conpty"
)

// Starts every detected local shell on a pseudo-console, runs a command and
// checks its output comes back.
func TestLocalShellsRoundTrip(t *testing.T) {
	shells := (&App{}).ListShells()
	if len(shells) == 0 {
		t.Fatal("no local shells detected")
	}
	for _, sh := range shells {
		if sh.ID == "wsl" {
			continue // may have no distro installed; not a Remterm concern
		}
		t.Run(sh.ID, func(t *testing.T) {
			cpty, err := conpty.Start(sh.Command, conpty.ConPtyDimensions(120, 30))
			if err != nil {
				t.Fatalf("start %s: %v", sh.Command, err)
			}
			defer cpty.Close()

			out := make(chan []byte, 64)
			go func() {
				buf := make([]byte, 4096)
				for {
					n, err := cpty.Read(buf)
					if n > 0 {
						out <- append([]byte(nil), buf[:n]...)
					}
					if err != nil {
						close(out)
						return
					}
				}
			}()

			cmd := "echo remterm-ok-42"
			if sh.ID == "pwsh" || sh.ID == "powershell" {
				cmd = "Write-Output ('remterm-ok-' + (40+2))"
			}
			time.Sleep(1500 * time.Millisecond) // let the shell print its prompt
			if _, err := cpty.Write([]byte(cmd + "\r")); err != nil {
				t.Fatal(err)
			}

			var got bytes.Buffer
			deadline := time.After(15 * time.Second)
			for !strings.Contains(got.String(), "remterm-ok-42") {
				select {
				case b, ok := <-out:
					if !ok {
						t.Fatalf("shell closed early; output:\n%q", got.String())
					}
					got.Write(b)
				case <-deadline:
					t.Fatalf("no expected output; got:\n%q", got.String())
				}
			}

			_, _ = cpty.Write([]byte("exit\r"))
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			code, err := cpty.Wait(ctx)
			if err != nil {
				t.Fatalf("wait: %v", err)
			}
			t.Logf("%s exited with code %d", sh.Name, code)
		})
	}
}
