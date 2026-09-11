import React from 'react'
import { useEditorStore } from '../store'

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    const msg = `${error?.message || error}${info?.componentStack ? '\n' + info.componentStack : ''}`
    try { useEditorStore.getState().addLog({ level: 'error', message: msg }) } catch {}
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 16, color: 'var(--error)', background: 'var(--error-bg)', borderRadius: 'var(--radius)', margin: 8 }}>
          <div style={{ marginBottom: 8, fontWeight: 'bold' }}>Something went wrong</div>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 12 }}>{this.state.error?.message || 'Unknown error'}</div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="btn"
          >
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
