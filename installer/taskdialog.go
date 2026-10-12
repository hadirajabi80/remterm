//go:build windows

package main

import (
	"encoding/binary"
	"errors"
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

// A small TaskDialogIndirect wrapper (comctl32 v6, enabled by the manifest):
// the setup's windows, with the app icon, command-link buttons and a
// checkbox. Callers fall back to MessageBox when it returns an error.

type button struct {
	id   int32
	text string // "Title\nsmaller explanation" for command links
}

type dialog struct {
	instruction string
	content     string
	buttons     []button
	cancel      bool // a Cancel button
	closeButton bool // a Close button
	verify      string
	expanded    string
	expandLabel string
}

type dialogResult struct {
	button   int32
	verified bool
}

var (
	comctl32            = windows.NewLazySystemDLL("comctl32.dll")
	procTaskDialogIndir = comctl32.NewProc("TaskDialogIndirect")
	user32              = windows.NewLazySystemDLL("user32.dll")
	procLoadImageW      = user32.NewProc("LoadImageW")
)

const (
	tdfEnableHyperlinks  = 0x0001
	tdfUseHiconMain      = 0x0002
	tdfAllowCancellation = 0x0008
	tdfUseCommandLinks   = 0x0010
	tdfPositionRelative  = 0x1000
	tdcbfCancel          = 0x0008
	tdcbfClose           = 0x0020
)

func taskDialog(d dialog) (dialogResult, error) {
	if procTaskDialogIndir.Find() != nil {
		return dialogResult{}, errors.New("no task dialog")
	}
	// TASKDIALOGCONFIG is declared with 1-byte packing in commctrl.h; try
	// that layout first and the naturally aligned one if Windows rejects it.
	r, err := runTaskDialog(d, true)
	if err != nil {
		r, err = runTaskDialog(d, false)
	}
	return r, err
}

// layout writes struct fields at packed or naturally aligned offsets.
type layout struct {
	buf    []byte
	packed bool
}

func (l *layout) align(n int) {
	if l.packed {
		return
	}
	for len(l.buf)%n != 0 {
		l.buf = append(l.buf, 0)
	}
}

func (l *layout) u32(v uint32) {
	l.align(4)
	l.buf = binary.LittleEndian.AppendUint32(l.buf, v)
}

func (l *layout) ptr(v uintptr) {
	l.align(8)
	l.buf = binary.LittleEndian.AppendUint64(l.buf, uint64(v))
}

func runTaskDialog(d dialog, packed bool) (dialogResult, error) {
	var keep [][]uint16 // UTF-16 strings must stay alive during the call
	str := func(s string) uintptr {
		if s == "" {
			return 0
		}
		p, _ := windows.UTF16FromString(s)
		keep = append(keep, p)
		return uintptr(unsafe.Pointer(&p[0]))
	}

	// TASKDIALOG_BUTTON array
	btn := &layout{packed: packed}
	for _, b := range d.buttons {
		btn.u32(uint32(b.id))
		btn.ptr(str(b.text))
		btn.align(8)
	}
	var pButtons uintptr
	if len(btn.buf) > 0 {
		pButtons = uintptr(unsafe.Pointer(&btn.buf[0]))
	}

	var hInst windows.Handle
	_ = windows.GetModuleHandleEx(0, nil, &hInst)
	icon, _, _ := procLoadImageW.Call(uintptr(hInst), 3, 1 /* IMAGE_ICON */, 32, 32, 0) // resource ID 3: the app icon

	flags := uint32(tdfAllowCancellation | tdfPositionRelative | tdfEnableHyperlinks)
	if len(d.buttons) > 0 {
		flags |= tdfUseCommandLinks
	}
	if icon != 0 {
		flags |= tdfUseHiconMain
	}
	var common uint32
	if d.cancel {
		common |= tdcbfCancel
	}
	if d.closeButton {
		common |= tdcbfClose
	}

	c := &layout{packed: packed}
	c.u32(0)                      // cbSize, set below
	c.ptr(0)                      // hwndParent
	c.ptr(uintptr(hInst))         // hInstance
	c.u32(flags)                  // dwFlags
	c.u32(common)                 // dwCommonButtons
	c.ptr(str(title))             // pszWindowTitle
	c.ptr(icon)                   // hMainIcon
	c.ptr(str(d.instruction))     // pszMainInstruction
	c.ptr(str(d.content))         // pszContent
	c.u32(uint32(len(d.buttons))) // cButtons
	c.ptr(pButtons)               // pButtons
	defBtn := int32(0)
	if len(d.buttons) > 0 {
		defBtn = d.buttons[0].id
	}
	c.u32(uint32(defBtn))                    // nDefaultButton
	c.u32(0)                                 // cRadioButtons
	c.ptr(0)                                 // pRadioButtons
	c.u32(0)                                 // nDefaultRadioButton
	c.ptr(str(d.verify))                     // pszVerificationText
	c.ptr(str(d.expanded))                   // pszExpandedInformation
	c.ptr(str(orDefault(d.expandLabel, ""))) // pszExpandedControlText
	c.ptr(str(orDefault(d.expandLabel, ""))) // pszCollapsedControlText
	c.ptr(0)                                 // hFooterIcon
	c.ptr(0)                                 // pszFooter
	c.ptr(0)                                 // pfCallback
	c.ptr(0)                                 // lpCallbackData
	c.u32(0)                                 // cxWidth (auto)
	c.align(8)
	binary.LittleEndian.PutUint32(c.buf[0:], uint32(len(c.buf)))

	var pressed, radio int32
	var verified int32
	hr, _, _ := procTaskDialogIndir.Call(
		uintptr(unsafe.Pointer(&c.buf[0])),
		uintptr(unsafe.Pointer(&pressed)),
		uintptr(unsafe.Pointer(&radio)),
		uintptr(unsafe.Pointer(&verified)),
	)
	runtime.KeepAlive(keep)
	runtime.KeepAlive(btn)
	if int32(hr) < 0 {
		return dialogResult{}, windows.Errno(hr)
	}
	return dialogResult{button: pressed, verified: verified != 0}, nil
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
