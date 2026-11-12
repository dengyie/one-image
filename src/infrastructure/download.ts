// One download path for every "save a blob to the user's disk" flow: object
// URL + synthetic click + deferred revoke. Previously copy-pasted three times
// in App.tsx with the same 1s revoke window.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
