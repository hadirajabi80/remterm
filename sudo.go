package main

import (
	"io"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Only a submitted sudo command arms the responder. Generic Password: prompts
// (su, nested SSH, database clients, etc.) must never receive this credential.
var sudoCommand = regexp.MustCompile(`(?:^|[\s;&|()])(?:/[^\s;&|()]*/)?sudo(?:\s|$)`)

const sudoPromptDelay = 100 * time.Millisecond

type sudoResponder struct {
	mu         sync.Mutex
	prompt     string
	password   string
	input      []rune
	dirty      bool
	escape     byte
	armedUntil time.Time
	generation uint64
	timer      *time.Timer
	revision   uint64
}

func validSudoPassword(password string) bool {
	return !strings.ContainsFunc(password, func(r rune) bool { return r < ' ' || r == 127 })
}

func newSudoResponder(user, password string) *sudoResponder {
	if user == "" || password == "" || !validSudoPassword(password) {
		return nil
	}
	return &sudoResponder{prompt: "[sudo] password for " + user + ":", password: password}
}

func (s *Session) writeInput(data string) error {
	s.inputMu.Lock()
	defer s.inputMu.Unlock()
	select {
	case <-s.done:
		return io.ErrClosedPipe
	default:
	}
	if s.sudo != nil {
		s.sudo.mu.Lock()
		s.sudo.onInput(data)
		s.sudo.mu.Unlock()
	}
	_, err := io.WriteString(s.stdin, data)
	return err
}

// Input editing we cannot reliably reconstruct (completion, shell history,
// cursor movement) falls back to manual entry rather than guessing a command.
func (r *sudoResponder) onInput(data string) {
	r.cancel()
	r.generation++
	r.armedUntil = time.Time{}
	data = strings.ReplaceAll(strings.ReplaceAll(data, "\x1b[200~", ""), "\x1b[201~", "")
	for _, ch := range data {
		if r.escape != 0 {
			if r.escape == 1 && ch == '[' {
				r.escape = 2
			} else if r.escape != 2 || (ch >= 0x40 && ch <= 0x7e) {
				r.escape = 0
			}
			continue
		}
		switch ch {
		case '\r', '\n':
			if !r.dirty && sudoCommand.MatchString(string(r.input)) {
				r.armedUntil = time.Now().Add(2 * time.Minute)
			} else if len(r.input) > 0 {
				r.armedUntil = time.Time{}
			}
			r.input, r.dirty = nil, false
		case '\x03', '\x15': // Ctrl+C / Ctrl+U
			r.input, r.dirty = nil, false
		case '\b', '\x7f':
			if len(r.input) > 0 {
				r.input = r.input[:len(r.input)-1]
			}
		case '\x1b':
			r.dirty, r.escape = true, 1
		default:
			if ch < ' ' || len(r.input) >= 4096 {
				r.dirty = true
			} else if !r.dirty {
				r.input = append(r.input, ch)
			}
		}
	}
}

func (r *sudoResponder) cancel() {
	r.revision++
	if r.timer != nil {
		r.timer.Stop()
		r.timer = nil
	}
}

// Each output stream has its own incremental parser: SSH can split a prompt or
// an ANSI escape at any byte. Only the unfinished current line can be a prompt.
type sudoOutput struct {
	line       []byte
	escape     byte
	generation uint64
	overflow   bool
}

func (o *sudoOutput) feed(data []byte) {
	for _, ch := range data {
		switch o.escape {
		case 1:
			switch ch {
			case '[':
				o.escape = 2 // CSI
			case ']':
				o.escape = 3 // OSC
			default:
				o.escape = 0
			}
			continue
		case 2:
			if ch >= 0x40 && ch <= 0x7e {
				o.escape = 0
			}
			continue
		case 3:
			if ch == '\a' {
				o.escape = 0
			} else if ch == '\x1b' {
				o.escape = 4
			}
			continue
		case 4:
			if ch == '\\' {
				o.escape = 0
			} else {
				o.escape = 3
			}
			continue
		}
		switch ch {
		case '\x1b':
			o.escape = 1
		case '\r', '\n':
			o.line, o.overflow = nil, false
		case '\b', '\x7f':
			if len(o.line) > 0 {
				o.line = o.line[:len(o.line)-1]
			}
		default:
			if ch >= ' ' {
				if len(o.line) < 512 {
					o.line = append(o.line, ch)
				} else {
					o.overflow = true
				}
			}
		}
	}
}

func (s *Session) observeSudo(output *sudoOutput, data []byte) {
	if s.sudo == nil {
		return
	}
	r := s.sudo
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cancel()
	if output.generation != r.generation {
		*output = sudoOutput{generation: r.generation}
	}
	output.feed(data)
	if time.Now().After(r.armedUntil) || output.overflow || output.escape != 0 || strings.TrimSpace(string(output.line)) != r.prompt {
		return
	}
	generation := r.generation
	revision := r.revision
	// Let trailing bytes/newlines arrive before answering text that only looks
	// like a prompt. Any user input cancels the pending automatic reply too.
	r.timer = time.AfterFunc(sudoPromptDelay, func() {
		s.inputMu.Lock()
		defer s.inputMu.Unlock()
		r.mu.Lock()
		select {
		case <-s.done:
			r.mu.Unlock()
			return
		default:
		}
		if r.generation != generation || r.revision != revision || time.Now().After(r.armedUntil) {
			r.mu.Unlock()
			return
		}
		// Consume the attempt before writing. A rejected password's next
		// prompt stays manual; automatic retries cannot lock the account.
		r.armedUntil = time.Time{}
		r.timer = nil
		password := r.password
		r.mu.Unlock()
		_, _ = io.WriteString(s.stdin, password+"\n")
	})
}

func (s *Session) stopSudo() {
	if s.sudo != nil {
		s.sudo.mu.Lock()
		defer s.sudo.mu.Unlock()
		s.sudo.cancel()
		s.sudo.password = ""
		s.sudo.input = nil
	}
}
