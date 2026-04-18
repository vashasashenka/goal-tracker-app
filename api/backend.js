import app from '../backend/index.js'

function normalizeForwardedPath(path) {
  return String(path || '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
}

export default function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost'
  const proto = req.headers['x-forwarded-proto'] || 'https'
  const url = new URL(req.url || '/', `${proto}://${host}`)

  const forwardedPath = normalizeForwardedPath(url.searchParams.get('path'))
  url.searchParams.delete('path')

  const pathname = forwardedPath ? `/api/${forwardedPath}` : '/api'
  req.url = `${pathname}${url.search}`

  return app(req, res)
}
