package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/zalando/go-keyring"
)

func TestSavedPasswordsLifecycle(t *testing.T) {
	keyring.MockInit()
	t.Cleanup(keyring.MockInit)
	a := newTestApp(t, startTestServer(t))
	item, err := a.SavePassword(PasswordItem{Title: "  Production sudo  "}, "private-test-password")
	if err != nil || item.ID == "" || item.Title != "Production sudo" {
		t.Fatalf("save: %+v %v", item, err)
	}
	item.Title = "Renamed password"
	if _, err := a.SavePassword(item, ""); err != nil {
		t.Fatal(err)
	}
	if value, err := a.passwordValue(item.ID); err != nil || value != "private-test-password" {
		t.Fatalf("rename lost password: %q %v", value, err)
	}
	if _, err := a.SavePassword(PasswordItem{Title: "renamed PASSWORD"}, "duplicate-secret"); err == nil {
		t.Fatal("duplicate titles made password selection ambiguous")
	}
	store, err := OpenStore()
	if err != nil {
		t.Fatal(err)
	}
	a.store = store
	items := a.ListPasswords()
	if len(items) != 1 || items[0].Title != item.Title {
		t.Fatalf("reload: %+v", items)
	}
	raw, err := os.ReadFile(store.path)
	if err != nil || bytes.Contains(raw, []byte("private-test-password")) {
		t.Fatalf("password in host data or read failed: %v", err)
	}
	response, _ := json.Marshal(items)
	if bytes.Contains(response, []byte("private-test-password")) {
		t.Fatal("list exposed the password to the frontend")
	}
	if _, err := a.SavePassword(item, "replacement-password"); err != nil {
		t.Fatal(err)
	}
	if value, _ := a.passwordValue(item.ID); value != "replacement-password" {
		t.Fatal("password was not replaced")
	}
	for _, field := range []string{"login", "sudo"} {
		h := Host{Address: "example.test", Name: "Production"}
		if field == "login" {
			h.PasswordID = item.ID
		} else {
			h.SudoPasswordID = item.ID
		}
		h, err = a.SaveHost(h, "", "")
		if err != nil {
			t.Fatal(err)
		}
		if err := a.DeletePassword(item.ID); err == nil || !strings.Contains(err.Error(), "Production") {
			t.Fatalf("deleted an assigned %s password: %v", field, err)
		}
		if value, _ := a.passwordValue(item.ID); value != "replacement-password" {
			t.Fatal("blocked deletion removed the secret")
		}
		if err := a.DeleteHost(h.ID); err != nil {
			t.Fatal(err)
		}
	}
	if err := a.DeletePassword(item.ID); err != nil {
		t.Fatal(err)
	}
	if len(a.ListPasswords()) != 0 || getNamedSecret("password:"+item.ID) != "" {
		t.Fatal("deletion left metadata or credentials")
	}
}

func TestSavedPasswordValidation(t *testing.T) {
	keyring.MockInit()
	t.Cleanup(keyring.MockInit)
	a := newTestApp(t, startTestServer(t))
	for _, tc := range []struct{ title, password string }{{"", "secret"}, {"Title", ""}, {"Title", "bad\ncommand"}} {
		if _, err := a.SavePassword(PasswordItem{Title: tc.title}, tc.password); err == nil {
			t.Fatalf("accepted invalid password entry %+v", tc)
		}
	}
	if _, err := a.SavePassword(PasswordItem{ID: "deleted", Title: "Title"}, "secret"); err == nil {
		t.Fatal("editing a deleted item recreated it")
	}
	for _, h := range []Host{
		{Address: "example.test", PasswordID: "deleted"},
		{Address: "example.test", SudoPasswordID: "deleted"},
	} {
		if _, err := a.SaveHost(h, "", ""); err == nil {
			t.Fatal("host accepted an unavailable saved password")
		}
	}
	keyring.MockInitWithError(errors.New("locked"))
	if _, err := a.SavePassword(PasswordItem{Title: "Title"}, "secret"); err == nil || len(a.ListPasswords()) != 0 {
		t.Fatal("credential-store error was ignored")
	}
}

func TestSavedPasswordSSHAuth(t *testing.T) {
	keyring.MockInit()
	t.Cleanup(keyring.MockInit)
	srv := startTestServer(t)
	a := newTestApp(t, srv)
	item, err := a.SavePassword(PasswordItem{Title: "Shared SSH login"}, "pw")
	if err != nil {
		t.Fatal(err)
	}
	host, port := splitAddr(t, srv.addr)
	h := Host{ID: "saved-host", Address: host, Port: port, User: "u", AuthMethod: "password", PasswordID: item.ID, HasSecret: true}
	if err := setSecret(h.ID, "wrong-host-password"); err != nil {
		t.Fatal(err)
	}
	c, err := a.connectHost(h, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if c.loginPassword != "pw" {
		t.Fatal("did not use the selected saved password")
	}
	c.Close()
	if _, err := a.SavePassword(item, "wrong-shared-password"); err != nil {
		t.Fatal(err)
	}
	if c, err := a.connectHost(h, "", nil); err == nil {
		c.Close()
		t.Fatal("reconnect used the old shared password")
	}
	c, err = a.connectHost(h, "pw", nil)
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	if value, _ := a.passwordValue(item.ID); value != "wrong-shared-password" {
		t.Fatal("a one-time login override changed the shared password")
	}
	deleteNamedSecret("password:" + item.ID)
	if _, err := a.connectHost(h, "", nil); err == nil || !strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("missing credential silently fell back: %v", err)
	}
}

func TestSavedPasswordFillTargetsOneTerminal(t *testing.T) {
	keyring.MockInit()
	t.Cleanup(keyring.MockInit)
	a := newTestApp(t, startTestServer(t))
	item, err := a.SavePassword(PasswordItem{Title: "Fill me"}, "fill-only-password")
	if err != nil {
		t.Fatal(err)
	}
	s, writer := sudoTestSession(t)
	other, otherWriter := sudoTestSession(t)
	a.sessions["active"], a.sessions["other"] = s, other
	_ = s.writeInput("sudo id\n")
	expectSudoWrite(t, writer, "sudo id\n")
	var output sudoOutput
	s.observeSudo(&output, []byte("[sudo] password for alice: "))
	if err := a.FillSavedPassword("active", item.ID); err != nil {
		t.Fatal(err)
	}
	expectSudoWrite(t, writer, "fill-only-password") // no Enter appended
	expectNoSudoWrite(t, writer)                     // pending sudo reply was canceled
	expectNoSudoWrite(t, otherWriter)                // never broadcast to the other pane
	if len(s.sudo.input) != 0 || !s.sudo.armedUntil.IsZero() {
		t.Fatal("filled password entered the command tracker")
	}
	delete(a.sessions, "active")
	if err := a.FillSavedPassword("active", item.ID); err == nil {
		t.Fatal("fill allowed a closed session")
	}
	deleteNamedSecret("password:" + item.ID)
	if err := a.FillSavedPassword("other", item.ID); err == nil {
		t.Fatal("fill ignored missing credentials")
	}
}
