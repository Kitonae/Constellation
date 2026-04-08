// UI dialog helpers that work without Tauri by using a hidden file input.

// Internal helper returning an array of { file, path } objects.
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
      // Browser security: f.path is not exposed; use name only.
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
  return await chooseFiles('image/*,video/*,.gltf,.glb,.obj', true, false)
}

export async function openMediaFolder() {
  // accept argument is ignored for directory selection in most browsers
  return await chooseFiles(null, false, true)
}
