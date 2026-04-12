// UI dialog helpers — prefer native Wails dialogs (returns absolute paths),
// fall back to HTML <input> when not in Wails.

// Internal helper returning an array of { file, path } objects via HTML input.
function chooseFiles(accept, multiple = false, directory = false) {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (accept) input.accept = accept
    if (multiple) input.multiple = true
    if (directory) {
      input.webkitdirectory = true
      input.directory = true
    }
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    document.body.appendChild(input)
    input.addEventListener('change', () => {
      const files = Array.from(input.files || [])
      document.body.removeChild(input)
      if (!files.length) { resolve([]); return }
      resolve(files.map(f => ({ file: f, path: f.path || f.name })))
    }, { once: true })
    input.addEventListener('cancel', () => {
      document.body.removeChild(input)
      resolve([])
    }, { once: true })
    input.click()
  })
}

export async function openImageDialog() {
  const res = await chooseFiles('.png,.jpg,.jpeg,.gif,.bmp,.webp', false, false)
  return res.length ? res[0].path : null
}

// New helper returning both file and path for richer importing (data URL fallback)
export async function openImageFile() {
  const res = await chooseFiles('.png,.jpg,.jpeg,.gif,.bmp,.webp', false, false)
  return res.length ? res[0] : null
}

export async function openMediaDialog() {
  const res = await chooseFiles('image/*,video/*', false, false)
  return res.length ? res[0].path : null
}

export async function openMediaFile() {
  const res = await chooseFiles('image/*,video/*', false, false)
  return res.length ? res[0] : null
}

export async function openMediaFiles() {
  // In Wails, use the native dialog which returns absolute paths directly.
  // This avoids blob: URIs which can't work in cross-origin display windows.
  if (window.go?.main?.App?.PickMediaFiles) {
    try {
      const paths = await window.go.main.App.PickMediaFiles()
      if (paths && paths.length) {
        return paths.map(p => ({ file: null, path: p }))
      }
      return []
    } catch (e) {
      console.warn('Native file dialog failed, falling back to HTML input', e)
    }
  }
  return await chooseFiles('image/*,video/*,.gltf,.glb,.obj', true, false)
}

export async function openMediaFolder() {
  // In Wails, use the native directory dialog which returns absolute paths.
  if (window.go?.main?.App?.PickMediaFolder) {
    try {
      const paths = await window.go.main.App.PickMediaFolder()
      if (paths && paths.length) {
        return paths.map(p => ({ file: null, path: p }))
      }
      return []
    } catch (e) {
      console.warn('Native folder dialog failed, falling back to HTML input', e)
    }
  }
  return await chooseFiles(null, false, true)
}
