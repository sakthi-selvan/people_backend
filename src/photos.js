import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { dataDir } from './store.js'

export const facesDir = join(dataDir, 'uploads', 'faces')
mkdirSync(facesDir, { recursive: true })

export function saveFacePhoto(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) return null
  if (dataUrl.length > 800000) return null
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const header = dataUrl.slice(0, comma)
  const ext = header.includes('png') ? 'png' : header.includes('webp') ? 'webp' : 'jpg'
  const buf = Buffer.from(dataUrl.slice(comma + 1), 'base64')
  if (!buf.length) return null
  const id = randomUUID()
  writeFileSync(join(facesDir, `${id}.${ext}`), buf)
  return `/uploads/faces/${id}.${ext}`
}

export function demoFacePhoto(name, action, hue = 200) {
  const label = `${name} · ${action}`
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="300" viewBox="0 0 240 300">
  <rect width="240" height="300" fill="hsl(${hue},32%,16%)"/>
  <circle cx="120" cy="118" r="52" fill="hsl(${hue},35%,72%)"/>
  <ellipse cx="120" cy="250" rx="78" ry="70" fill="hsl(${hue},28%,28%)"/>
  <circle cx="102" cy="110" r="6" fill="hsl(${hue},20%,20%)"/>
  <circle cx="138" cy="110" r="6" fill="hsl(${hue},20%,20%)"/>
  <path d="M102 138 Q120 150 138 138" fill="none" stroke="hsl(${hue},20%,25%)" stroke-width="3"/>
  <rect y="248" width="240" height="52" fill="hsl(${hue},40%,12%)"/>
  <text x="120" y="270" text-anchor="middle" fill="white" font-size="13" font-family="sans-serif">${escapeXml(label)}</text>
  <text x="120" y="288" text-anchor="middle" fill="hsl(${hue},20%,70%)" font-size="11" font-family="sans-serif">Face capture</text>
</svg>`
  const id = randomUUID()
  writeFileSync(join(facesDir, `${id}.svg`), svg)
  return `/uploads/faces/${id}.svg`
}

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function hueFrom(text) {
  let n = 0
  for (const ch of String(text)) n += ch.charCodeAt(0)
  return n % 360
}
