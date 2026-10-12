package main

import (
	"strings"
	"sync"
	"time"
)

// rememberMu serializes find-or-create so two quick connects to the same
// server at once do not save it twice.
var rememberMu sync.Mutex

// findHost returns the saved host with the same address, port and user.
func (a *App) findHost(h Host) (Host, bool) {
	user := h.User
	if user == "" {
		user = defaultUser()
	}
	for _, x := range a.store.Hosts() {
		xu := x.User
		if xu == "" {
			xu = defaultUser()
		}
		if strings.EqualFold(x.Address, h.Address) && x.Port == h.Port && xu == user {
			return x, true
		}
	}
	return Host{}, false
}

// rememberConnection runs after a successful login: it saves quick-connect
// targets as hosts, stores the password if asked, and records the time.
func (a *App) rememberConnection(h Host, password string, savePassword bool) ConnectResult {
	var res ConnectResult

	if h.ID == "" {
		rememberMu.Lock()
		if saved, ok := a.findHost(h); ok {
			h = saved
		} else {
			if h.User == "" {
				h.User = defaultUser()
			}
			h.ID = newID()
			h.Name = h.Address
			h.Group = "Quick connect"
			if err := a.store.PutHost(h); err == nil {
				res.Saved = true
			} else {
				h.ID = ""
			}
		}
		rememberMu.Unlock()
	}
	if h.ID == "" {
		return res
	}
	res.HostID = h.ID

	hasSecret := false
	if password != "" && savePassword {
		hasSecret = setSecret(h.ID, password) == nil
	}
	_ = a.store.UpdateHost(h.ID, func(x *Host) {
		x.LastUsed = time.Now().UnixMilli()
		if hasSecret {
			x.HasSecret = true
		}
	})
	return res
}
