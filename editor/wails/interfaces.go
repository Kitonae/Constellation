package main

// Broadcaster defines the SSE event broadcasting contract.
// Implemented by SSEHub; mockable for testing.
type Broadcaster interface {
	BroadcastSnapshot(data []byte)
	BroadcastTime(t float64)
	BroadcastTransport(payload []byte)
	BroadcastControl(command string)
	SendScreenOpen(screenID string, width, height int)
	SendScreenOpenAt(screenID string, p ScreenPlacement)
	SendScreenClose(screenID string)
	CloseAllScreens()
}

// ProcessManager defines the renderer process lifecycle contract.
// Implemented by RendererManager; mockable for testing.
type ProcessManager interface {
	LaunchRenderer(screenID string, serverPort, width, height int) error
	LaunchRendererAt(screenID string, serverPort int, p ScreenPlacement) error
	StopRenderer(screenID string) error
	ShutdownAll()
	KillOrphans() int
	GetStatus(screenID string) RendererStatus
	UpdateStatus(status RendererStatus)
}

// FileReader defines the file-to-base64 conversion contract.
// Implemented by FileService; mockable for testing.
type FileReader interface {
	ReadFileBase64(path string) (string, error)
}
