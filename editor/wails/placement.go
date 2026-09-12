package main

// ScreenPlacement says where a renderer's output window goes on the desktop.
//
// X and Y are physical pixels in Windows' virtual-screen space, the same
// coordinates the Output panel shows for each display; the renderer is
// per-monitor DPI aware, so they map one to one. Positioned false means "let
// Windows choose", which is what every screen did before placement existed.
type ScreenPlacement struct {
	Width      int  `json:"width"`
	Height     int  `json:"height"`
	Positioned bool `json:"positioned"`
	X          int  `json:"x"`
	Y          int  `json:"y"`
	Borderless bool `json:"borderless"`
}
