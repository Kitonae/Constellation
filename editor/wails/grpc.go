package main

import (
	"context"
	"fmt"
	"time"

	pb "github.com/kitonae/constellation/editor/internal/proto/proto/constellation/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// ApplyProject loads a project JSON and sends it to the display server
func (a *App) ApplyProject(addr string, projectJSON string) (string, error) {
	// Parse JSON to protobuf
	project, err := JSONToProject(projectJSON)
	if err != nil {
		return "", fmt.Errorf("parse error: %w", err)
	}

	// Connect to display server
	conn, err := grpc.Dial(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return "", fmt.Errorf("connection error: %w", err)
	}
	defer conn.Close()

	client := pb.NewDisplayControlClient(conn)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Send load project request
	req := &pb.LoadProjectRequest{Project: project}
	ack, err := client.LoadProject(ctx, req)
	if err != nil {
		return "", err
	}

	if !ack.Ok {
		return "", fmt.Errorf(ack.Message)
	}
	return ack.Message, nil
}

// Play starts playback on the display server
func (a *App) Play(addr string, at *float64) (string, error) {
	conn, err := grpc.Dial(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return "", fmt.Errorf("connection error: %w", err)
	}
	defer conn.Close()

	client := pb.NewDisplayControlClient(conn)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	atSeconds := 0.0
	if at != nil {
		atSeconds = *at
	}

	req := &pb.PlayRequest{AtSeconds: atSeconds}
	ack, err := client.Play(ctx, req)
	if err != nil {
		return "", err
	}

	if !ack.Ok {
		return "", fmt.Errorf(ack.Message)
	}
	return ack.Message, nil
}

// Pause pauses playback on the display server
func (a *App) Pause(addr string) (string, error) {
	conn, err := grpc.Dial(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return "", fmt.Errorf("connection error: %w", err)
	}
	defer conn.Close()

	client := pb.NewDisplayControlClient(conn)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req := &pb.PauseRequest{}
	ack, err := client.Pause(ctx, req)
	if err != nil {
		return "", err
	}

	if !ack.Ok {
		return "", fmt.Errorf(ack.Message)
	}
	return ack.Message, nil
}

// Stop stops playback on the display server
func (a *App) Stop(addr string) (string, error) {
	conn, err := grpc.Dial(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return "", fmt.Errorf("connection error: %w", err)
	}
	defer conn.Close()

	client := pb.NewDisplayControlClient(conn)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req := &pb.StopRequest{}
	ack, err := client.Stop(ctx, req)
	if err != nil {
		return "", err
	}

	if !ack.Ok {
		return "", fmt.Errorf(ack.Message)
	}
	return ack.Message, nil
}

// Seek seeks to a specific time on the display server
func (a *App) Seek(addr string, to float64) (string, error) {
	conn, err := grpc.Dial(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return "", fmt.Errorf("connection error: %w", err)
	}
	defer conn.Close()

	client := pb.NewDisplayControlClient(conn)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req := &pb.SeekRequest{ToSeconds: to}
	ack, err := client.Seek(ctx, req)
	if err != nil {
		return "", err
	}

	if !ack.Ok {
		return "", fmt.Errorf(ack.Message)
	}
	return ack.Message, nil
}

// SetRate sets the playback rate on the display server
func (a *App) SetRate(addr string, rate float64) (string, error) {
	conn, err := grpc.Dial(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return "", fmt.Errorf("connection error: %w", err)
	}
	defer conn.Close()

	client := pb.NewDisplayControlClient(conn)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req := &pb.SetRateRequest{Rate: rate}
	ack, err := client.SetRate(ctx, req)
	if err != nil {
		return "", err
	}

	if !ack.Ok {
		return "", fmt.Errorf(ack.Message)
	}
	return ack.Message, nil
}
