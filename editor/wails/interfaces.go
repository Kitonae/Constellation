package main

// Broadcaster defines the SSE event broadcasting contract.
// Implemented by SSEHub; mockable for testing.
type Broadcaster interface {
	BroadcastSnapshot(data []byte)
	BroadcastTime(t float64)
	BroadcastControl(command string)
	SendScreenOpen(screenID string, width, height int)
	SendScreenClose(screenID string)
}

// ProcessManager defines the renderer process lifecycle contract.
// Implemented by RendererManager; mockable for testing.
type ProcessManager interface {
	LaunchRenderer(screenID string, serverPort, width, height int) error
	StopRenderer(screenID string) error
	ShutdownAll()
	GetStatus(screenID string) RendererStatus
	UpdateStatus(status RendererStatus)
}

// FileReader defines the file-to-base64 conversion contract.
// Implemented by FileService; mockable for testing.
type FileReader interface {
	ReadFileBase64(path string) (string, error)
}
