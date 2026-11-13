package main

import (
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
)

// PasswordItem contains public metadata only. The password lives in the OS
// credential store under password:<id> and is never returned to the frontend.
type PasswordItem struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

func passwordItemID(p PasswordItem) string { return p.ID }

func (a *App) ListPasswords() []PasswordItem {
	var out []PasswordItem
	a.store.read(func(d *storeData) { out = append(out, d.Passwords...) })
	sort.Slice(out, func(i, j int) bool { return strings.ToLower(out[i].Title) < strings.ToLower(out[j].Title) })
	return out
}

func (a *App) SavePassword(item PasswordItem, password string) (PasswordItem, error) {
	item.Title = strings.TrimSpace(item.Title)
	if item.Title == "" {
		return item, errors.New("password title is required")
	}
	if !validSudoPassword(password) {
		return item, errors.New("password cannot contain terminal control characters")
	}
	a.store.mu.Lock()
	defer a.store.mu.Unlock()
	items := a.store.data.Passwords
	_, exists := find(items, item.ID, passwordItemID)
	if item.ID != "" && !exists {
		return item, errors.New("saved password no longer exists")
	}
	if !exists && password == "" {
		return item, errors.New("password is required")
	}
	for _, other := range items {
		if other.ID != item.ID && strings.EqualFold(other.Title, item.Title) {
			return item, errors.New("a password with this title already exists; choose another title")
		}
	}
	if item.ID == "" {
		item.ID = newID()
	}
	if password != "" {
		if err := setNamedSecret("password:"+item.ID, password); err != nil {
			return item, fmt.Errorf("save password to credential store: %w", err)
		}
	}
	a.store.data.Passwords = upsert(append([]PasswordItem(nil), items...), item, passwordItemID)
	err := a.store.saveLocked()
	if err != nil {
		a.store.data.Passwords = items
		if !exists {
			deleteNamedSecret("password:" + item.ID)
		}
	}
	return item, err
}

// Assigned passwords cannot be deleted until their host references are removed,
// so removing a credential never silently switches a host to another password.
func (a *App) DeletePassword(id string) error {
	a.store.mu.Lock()
	for _, h := range a.store.data.Hosts {
		if h.PasswordID == id || h.SudoPasswordID == id {
			a.store.mu.Unlock()
			return fmt.Errorf("password is used by %q; remove it from that host first", h.Name)
		}
	}
	previous := a.store.data.Passwords
	a.store.data.Passwords = without(append([]PasswordItem(nil), previous...), id, passwordItemID)
	err := a.store.saveLocked()
	if err != nil {
		a.store.data.Passwords = previous
	}
	a.store.mu.Unlock()
	if err != nil {
		return err
	}
	deleteNamedSecret("password:" + id)
	return nil
}

func (a *App) passwordValue(id string) (string, error) {
	if _, ok := find(a.ListPasswords(), id, passwordItemID); !ok {
		return "", errors.New("saved password no longer exists")
	}
	password := getNamedSecret("password:" + id)
	if password == "" {
		return "", errors.New("saved password is unavailable; unlock your OS credential store or save it again")
	}
	return password, nil
}

// FillSavedPassword writes only to the explicitly selected terminal. It bypasses
// command history, clipboard and broadcast input, and does not submit Enter.
func (a *App) FillSavedPassword(sessionID, passwordID string) error {
	s := a.session(sessionID)
	if s == nil {
		return errors.New("session closed")
	}
	password, err := a.passwordValue(passwordID)
	if err != nil {
		return err
	}
	s.inputMu.Lock()
	defer s.inputMu.Unlock()
	select {
	case <-s.done:
		return io.ErrClosedPipe
	default:
	}
	if s.sudo != nil {
		s.sudo.mu.Lock()
		s.sudo.cancel()
		s.sudo.generation++
		s.sudo.armedUntil = time.Time{}
		s.sudo.input, s.sudo.dirty, s.sudo.escape = nil, false, 0
		s.sudo.mu.Unlock()
	}
	_, err = io.WriteString(s.stdin, password)
	return err
}
