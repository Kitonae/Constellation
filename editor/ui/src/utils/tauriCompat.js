// UI dialog helpers that work without Tauri by using a hidden file input.

// Internal helper returning both the File object and a best-effort path/name.
function chooseFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (accept) input.accept = accept
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    document.body.appendChild(input)
    input.addEventListener('change', () => {
      const f = input.files && input.files[0]
      document.body.removeChild(input)
      if (!f) { resolve(null); return }
      // Browser security: f.path is not exposed; use name only.
      // Under Tauri, f.path is available.
      const pathOrName = f.path || f.name
      resolve({ file: f, path: pathOrName })
    }, { once: true })
    input.click()
  })
}

export async function openImageDialog() {
  const res = await chooseFile('.png,.jpg,.jpeg,.gif,.bmp,.webp')
  return res ? res.path : null
}

// New helper returning both file and path for richer importing (data URL fallback)
export async function openImageFile() {
  return await chooseFile('.png,.jpg,.jpeg,.gif,.bmp,.webp')
}

export async function openMediaDialog() {
  const res = await chooseFile('image/*,video/*')
  return res ? res.path : null
}

export async function openMediaFile() {
  return await chooseFile('image/*,video/*')
}
