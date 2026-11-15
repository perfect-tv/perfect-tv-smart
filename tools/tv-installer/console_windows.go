//go:build windows

package main

import "syscall"

// Русский текст в консоли Windows: кодовая страница UTF-8
func consoleUTF8() {
	k := syscall.NewLazyDLL("kernel32.dll")
	k.NewProc("SetConsoleOutputCP").Call(65001)
	k.NewProc("SetConsoleCP").Call(65001)
}
