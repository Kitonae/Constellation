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
    try { useEditorStore.getState().addLog('error', msg) } catch {}
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 16, color: '#ff4444', background: '#1a0a0a', borderRadius: 6, margin: 8 }}>
          <div style={{ marginBottom: 8, fontWeight: 'bold' }}>Something went wrong</div>
          <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 12 }}>{this.state.error?.message || 'Unknown error'}</div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{ background: '#232636', color: '#c7cfdb', border: '1px solid #3a4060', borderRadius: 4, padding: '4px 12px', cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
