package main

import (
	"embed"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

// mainWindowClass names the Windows window class; the RDP engine finds the window by it.
const mainWindowClass = "RemtermWindow"

func main() {
	args := os.Args[1:]
	if handleCommandLine(args) {
		return
	}
	app := NewApp()
	app.launch.cwd = cwdFromArgs(args)

	err := wails.Run(&options.App{
		Title:            "Remterm",
		Width:            1320,
		Height:           820,
		MinWidth:         820,
		MinHeight:        520,
		BackgroundColour: &options.RGBA{R: 13, G: 17, B: 23, A: 255},
		AssetServer:      &assetserver.Options{Assets: assets},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		OnBeforeClose:    app.beforeClose,
		Bind:             []interface{}{app},
		// A second launch (e.g. Explorer's "Open in Remterm") opens a tab here.
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               "remterm-7c41f0d2-single-instance",
			OnSecondInstanceLaunch: app.onSecondInstance,
		},
		// Files dragged in from Explorer go to SFTP panes (upload) or terminals (paste path).
		DragAndDrop: &options.DragAndDrop{EnableFileDrop: true, DisableWebViewDrop: true},
		Windows: &windows.Options{
			Theme:           windows.Dark,
			WindowClassName: mainWindowClass,
		},
		Mac: &mac.Options{
			TitleBar:   mac.TitleBarDefault(),
			Appearance: mac.NSAppearanceNameDarkAqua,
			About:      &mac.AboutInfo{Title: "Remterm", Message: "SSH, Remote Desktop and terminals in one window."},
			// A folder dropped on the Dock icon or sent by Finder's "Open in Remterm".
			OnFileOpen: app.onFileOpen,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
