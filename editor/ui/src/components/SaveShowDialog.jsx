import React, { useState, useEffect, useRef } from 'react'

export default function SaveShowDialog({ open, onClose, onSave, defaultName }) {
    const [filename, setFilename] = useState(defaultName || 'show')
    const inputRef = useRef(null)

    useEffect(() => {
        if (open) {
            setFilename(defaultName || 'show')
            setTimeout(() => inputRef.current?.focus(), 50)
        }
    }, [open, defaultName])

    if (!open) return null

    const handleSave = () => {
        const name = filename.trim() || 'show'
        onSave(name)
        onClose()
    }

    return (
        <div style={{
            position: 'fixed', inset: 0, zIndex: 3000,
            background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
            <div style={{
                width: 400, background: '#161922', border: '1px solid #232636', borderRadius: 8,
                boxShadow: '0 20px 50px rgba(0,0,0,0.5)', padding: 20, display: 'flex', flexDirection: 'column', gap: 16
            }}>
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#fff' }}>Save Show</h3>

                <div>
                    <label style={{ display: 'block', fontSize: 12, color: '#8b9bb4', marginBottom: 6 }}>Filename</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                            ref={inputRef}
                            value={filename}
                            onChange={(e) => setFilename(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSave()
                                if (e.key === 'Escape') onClose()
                            }}
                            style={{
                                flex: 1, background: '#0f1115', border: '1px solid #232636', borderRadius: 4,
                                padding: '8px 12px', color: '#fff', outline: 'none', fontSize: 14
                            }}
                        />
                        <span style={{ color: '#8b9bb4', fontSize: 14 }}>.json</span>
                    </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 10 }}>
                    <button
                        onClick={onClose}
                        style={{
                            background: 'transparent', border: '1px solid #232636', borderRadius: 4,
                            padding: '6px 16px', color: '#c7cfdb', cursor: 'pointer', fontSize: 14
                        }}
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSave}
                        style={{
                            background: '#3b82f6', border: 'none', borderRadius: 4,
                            padding: '6px 16px', color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 500
                        }}
                    >
                        Save
                    </button>
                </div>
            </div>
        </div>
    )
}
