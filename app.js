import {joinRoom} from 'https://cdn.jsdelivr.net/npm/trystero@0.25.4/nostr/+esm'
import QRCode from 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm'

const APP_ID = 'simpleshare'
const KEY_SECRET = 'ss.secret'
const KEY_NAME = 'ss.name'
const KEY_DEVICE = 'ss.device'
const KEY_DEVICES = 'ss.devices'
const RTC = {iceServers: [{urls: 'stun:stun.l.google.com:19302'}]}

const $ = id => document.getElementById(id)
const enc = new TextEncoder()
const dec = new TextDecoder()

const b64u = {
  encode: bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
}

const state = {
  secret: null,
  name: localStorage.getItem(KEY_NAME) || defaultName(),
  deviceId: localStorage.getItem(KEY_DEVICE) || newDeviceId(),
  known: loadKnown(),
  room: null,
  clip: null,
  hello: null,
  key: null,
  peers: new Map(),
  staged: null,
}

function newDeviceId() {
  const id = b64u.encode(crypto.getRandomValues(new Uint8Array(9)))
  localStorage.setItem(KEY_DEVICE, id)
  return id
}

function loadKnown() {
  try {
    return JSON.parse(localStorage.getItem(KEY_DEVICES)) || {}
  } catch {
    return {}
  }
}

function saveKnown() {
  localStorage.setItem(KEY_DEVICES, JSON.stringify(state.known))
}

const db = {
  open() {
    if (this.p) return this.p
    this.p = new Promise((res, rej) => {
      const req = indexedDB.open(APP_ID, 1)
      req.onupgradeneeded = () => req.result.createObjectStore('items', {keyPath: 'id'})
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    return this.p
  },
  async tx(mode, fn) {
    const d = await this.open()
    return new Promise((res, rej) => {
      const t = d.transaction('items', mode)
      const out = fn(t.objectStore('items'))
      t.oncomplete = () => res(out?.result)
      t.onerror = () => rej(t.error)
    })
  },
  all() { return this.tx('readonly', st => st.getAll()) },
  put(rec) { return this.tx('readwrite', st => st.put(rec)) },
  del(id) { return this.tx('readwrite', st => st.delete(id)) },
  clear() { return this.tx('readwrite', st => st.clear()) },
}

function defaultName() {
  const ua = navigator.userAgent
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/Android/.test(ua)) return 'Android'
  if (/Mac/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows'
  return 'Device'
}

function toast(msg, ms = 2600) {
  const el = $('toast')
  el.textContent = msg
  el.hidden = false
  clearTimeout(toast.t)
  toast.t = setTimeout(() => (el.hidden = true), ms)
}

function face(name) {
  for (const el of document.querySelectorAll('.face')) el.hidden = el.id !== `face-${name}`
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

async function deriveKey(secret) {
  const base = await crypto.subtle.importKey('raw', b64u.decode(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    {name: 'HKDF', hash: 'SHA-256', salt: enc.encode(APP_ID), info: enc.encode('clip')},
    base,
    {name: 'AES-GCM', length: 256},
    false,
    ['encrypt', 'decrypt']
  )
}

async function roomIdOf(secret) {
  const hash = await crypto.subtle.digest('SHA-256', b64u.decode(secret))
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
}

async function seal(bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, state.key, bytes))
  const out = new Uint8Array(iv.length + ct.length)
  out.set(iv)
  out.set(ct, iv.length)
  return out
}

async function open(buf) {
  const bytes = new Uint8Array(buf)
  return new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: bytes.slice(0, 12)}, state.key, bytes.slice(12)))
}

const pairUrl = () => `${location.origin}${location.pathname}#k=${state.secret}`
const newSecret = () => b64u.encode(crypto.getRandomValues(new Uint8Array(32)))

function parseSecret(input) {
  const s = String(input).trim()
  const m = s.match(/#?k=([A-Za-z0-9_-]{43})$/) || s.match(/^([A-Za-z0-9_-]{43})$/)
  return m ? m[1] : null
}

async function connect() {
  state.room?.leave()
  state.room = null
  state.peers.clear()
  renderPeers()
  state.key = await deriveKey(state.secret)
  const roomId = await roomIdOf(state.secret)
  const room = joinRoom(
    {appId: APP_ID, password: state.secret, rtcConfig: RTC, relayConfig: {redundancy: 5}},
    roomId,
    {onJoinError: e => toast(`연결 실패: ${e?.error || e}`)}
  )
  const hello = room.makeAction('hello')
  const clip = room.makeAction('clip')

  hello.onMessage = (data, {peerId}) => {
    const name = String(data?.name || peerId.slice(0, 6))
    const id = typeof data?.id === 'string' ? data.id : null
    state.peers.set(peerId, {name, id})
    if (id) {
      state.known[id] = {name, lastSeen: Date.now()}
      saveKnown()
    }
    renderPeers()
  }
  clip.onMessage = onReceive
  room.onPeerJoin = peerId => {
    state.peers.set(peerId, {name: peerId.slice(0, 6)})
    renderPeers()
    hello.send({id: state.deviceId, name: state.name}, {target: peerId})
  }
  room.onPeerLeave = peerId => {
    state.peers.delete(peerId)
    renderPeers()
  }
  Object.assign(state, {room, hello, clip})
}

function renderPeers() {
  const online = new Set([...state.peers.values()].map(p => p.id))
  const rows = Object.entries(state.known)
    .map(([id, d]) => ({id, name: d.name, online: online.has(id), lastSeen: d.lastSeen}))
    .sort((a, b) => b.online - a.online || b.lastSeen - a.lastSeen)
  for (const p of state.peers.values()) if (!p.id) rows.unshift({id: null, name: p.name, online: true})
  const ul = $('device-list')
  ul.replaceChildren(...rows.map(r => {
    const li = document.createElement('li')
    li.className = r.online ? 'on' : 'off'
    const name = document.createElement('span')
    name.className = 'dname'
    name.textContent = r.name
    li.appendChild(name)
    if (!r.online) {
      const rm = document.createElement('button')
      rm.className = 'rm'
      rm.title = '목록에서 제거'
      rm.setAttribute('aria-label', `${r.name} 목록에서 제거`)
      rm.textContent = '×'
      rm.onclick = () => {
        delete state.known[r.id]
        saveKnown()
        renderPeers()
      }
      li.appendChild(rm)
    }
    return li
  }))
  if (state.staged && !$('face-pick').hidden) renderTargets()
}

function stage(items) {
  if (!items.length) return
  if (state.peers.size === 0) return toast('연결된 기기가 없습니다')
  state.staged = items
  if (state.peers.size === 1) return sendStaged([...state.peers.keys()][0])
  renderStaged()
  renderTargets()
  face('pick')
}

function renderStaged() {
  const box = $('staged')
  box.replaceChildren()
  const items = state.staged
  const first = items[0]
  if (first.kind === 'text') {
    const snip = document.createElement('p')
    snip.className = 'snippet'
    snip.textContent = first.text
    box.appendChild(snip)
    return
  }
  if (first.blob.type.startsWith('image/')) {
    const img = document.createElement('img')
    img.className = 'thumb'
    img.alt = ''
    img.src = URL.createObjectURL(first.blob)
    box.appendChild(img)
  }
  const name = document.createElement('p')
  name.className = 'fname'
  name.textContent = items.length > 1 ? `${first.name} 외 ${items.length - 1}개` : first.name
  const meta = document.createElement('p')
  meta.className = 'fmeta'
  meta.textContent = fmtSize(items.reduce((s, i) => s + i.blob.size, 0))
  box.append(name, meta)
}

function renderTargets() {
  const wrap = $('pick-targets')
  const btn = (label, target) => {
    const b = document.createElement('button')
    b.className = 'ghost'
    b.textContent = label
    b.onclick = () => sendStaged(target)
    return b
  }
  wrap.replaceChildren(...[...state.peers].map(([id, p]) => btn(p.name, id)), btn('모두에게', undefined))
}

async function sendStaged(target) {
  const items = state.staged
  state.staged = null
  const label = target ? state.peers.get(target)?.name : '모든 기기'
  face('send')
  const bar = $('send-bar')
  try {
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      $('send-label').textContent = items.length > 1 ? `${label}로 보내는 중 (${i + 1}/${items.length})` : `${label}로 보내는 중`
      bar.style.width = '0'
      const bytes = it.kind === 'text' ? enc.encode(it.text) : new Uint8Array(await it.blob.arrayBuffer())
      const metadata = it.kind === 'text' ? {type: 'text'} : {type: 'file', name: it.name, mime: it.blob.type}
      await state.clip.send(await seal(bytes), {
        target,
        metadata,
        onProgress: p => (bar.style.width = `${Math.round(p * 100)}%`),
      })
      addHistory({...it, dir: 'sent', peer: label})
    }
    toast(`${label}에 보냈습니다`)
  } catch (e) {
    toast(`보내기 실패: ${e.message || e}`)
  } finally {
    face('idle')
  }
}

async function readClipboard() {
  if (navigator.clipboard?.read) {
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const mime = item.types.find(t => t.startsWith('image/'))
        if (mime) {
          const blob = await item.getType(mime)
          return [{kind: 'file', name: `clipboard.${mime.split('/')[1].replace('jpeg', 'jpg')}`, blob}]
        }
      }
      for (const item of items) {
        if (item.types.includes('text/plain')) {
          const text = await (await item.getType('text/plain')).text()
          return text ? [{kind: 'text', text}] : []
        }
      }
      return []
    } catch (e) {
      if (e.name !== 'NotAllowedError' && e.name !== 'DataError') throw e
    }
  }
  const text = await navigator.clipboard.readText()
  return text ? [{kind: 'text', text}] : []
}

async function onSendClipboard() {
  try {
    const items = await readClipboard()
    if (!items.length) return toast('클립보드가 비어 있습니다')
    stage(items)
  } catch {
    toast('클립보드를 읽을 수 없습니다. 텍스트 쓰기나 파일 선택을 이용하세요')
  }
}

function filesToItems(files) {
  return [...files].map(f => ({kind: 'file', name: f.name || 'file', blob: f}))
}

async function onReceive(buf, {peerId, metadata}) {
  let bytes
  try {
    bytes = await open(buf)
  } catch {
    return toast('받은 데이터를 풀 수 없습니다. 상대 기기의 그룹이 다를 수 있습니다')
  }
  const from = state.peers.get(peerId)?.name || peerId.slice(0, 6)
  const item = metadata?.type === 'file'
    ? {kind: 'file', name: metadata.name || 'file', blob: new Blob([bytes], {type: metadata.mime || 'application/octet-stream'})}
    : {kind: 'text', text: dec.decode(bytes)}
  addHistory({...item, dir: 'received', peer: from})
  const copied = await copyItem(item)
  if (copied) toast(`${from}에서 받아 클립보드에 넣었습니다`)
  else if (item.kind === 'text' || item.blob.type.startsWith('image/')) toast(`${from}에서 받았습니다. 복사를 누르세요`)
  else toast(`${from}에서 받았습니다`)
}

async function copyItem(item) {
  try {
    if (item.kind === 'text') {
      await navigator.clipboard.writeText(item.text)
      return true
    }
    if (!item.blob.type.startsWith('image/')) return false
    const png = item.blob.type === 'image/png' ? item.blob : await toPng(item.blob)
    await navigator.clipboard.write([new ClipboardItem({'image/png': png})])
    return true
  } catch {
    return false
  }
}

async function toPng(blob) {
  const bmp = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = bmp.height
  canvas.getContext('2d').drawImage(bmp, 0, 0)
  return new Promise(res => canvas.toBlob(res, 'image/png'))
}

function saveItem(item) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(item.blob)
  a.download = item.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 60000)
}

function addHistory(item) {
  const rec = {...item, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, ts: Date.now()}
  renderHistoryRow(rec)
  db.put(rec).catch(() => toast('기록을 저장하지 못했습니다'))
}

async function loadHistory() {
  try {
    const rows = await db.all()
    rows.sort((a, b) => a.ts - b.ts)
    for (const r of rows) renderHistoryRow(r)
  } catch {}
}

function removeHistory(id, li) {
  li.remove()
  db.del(id).catch(() => {})
  const empty = !$('inbox').children.length
  $('inbox-empty').hidden = !empty
  $('btn-clear').hidden = empty
}

function renderHistoryRow(rec) {
  $('inbox-empty').hidden = true
  $('btn-clear').hidden = false
  const li = document.createElement('li')
  const icon = document.createElement('div')
  icon.className = 'icon'
  const body = document.createElement('div')
  body.className = 'body'
  const title = document.createElement('div')
  title.className = 'title'
  const meta = document.createElement('div')
  meta.className = 'meta'
  const ops = document.createElement('div')
  ops.className = 'ops'
  const op = (label, fn, cls = '') => {
    const b = document.createElement('button')
    b.textContent = label
    b.className = cls
    b.onclick = fn
    ops.appendChild(b)
  }
  const when = new Date(rec.ts)
  const sameDay = when.toDateString() === new Date().toDateString()
  const time = sameDay
    ? when.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
    : when.toLocaleDateString([], {month: 'numeric', day: 'numeric'})
  const who = rec.dir === 'sent' ? `${rec.peer}로 보냄` : `${rec.peer}에서 받음`
  if (rec.kind === 'text') {
    icon.textContent = '텍스트'
    title.textContent = rec.text
    meta.textContent = `${who}, ${time}`
    op('복사', async () => toast((await copyItem(rec)) ? '복사했습니다' : '복사할 수 없습니다'))
  } else {
    const isImage = rec.blob.type.startsWith('image/')
    if (isImage) {
      const img = document.createElement('img')
      img.alt = ''
      img.src = URL.createObjectURL(rec.blob)
      icon.appendChild(img)
    } else {
      icon.textContent = (rec.name.split('.').pop() || 'file').slice(0, 4).toUpperCase()
    }
    title.textContent = rec.name
    meta.textContent = `${fmtSize(rec.blob.size)}, ${who}, ${time}`
    if (isImage) op('복사', async () => toast((await copyItem(rec)) ? '복사했습니다' : '복사할 수 없습니다'))
    op('저장', () => saveItem(rec))
  }
  op('×', () => removeHistory(rec.id, li), 'rm')
  ops.lastChild.setAttribute('aria-label', '기록에서 제거')
  body.append(title, meta)
  li.append(icon, body, ops)
  $('inbox').prepend(li)
}

async function showPair() {
  await QRCode.toCanvas($('qr'), pairUrl(), {width: 220, margin: 0})
  $('pair').showModal()
}

async function start(secret) {
  state.secret = secret
  localStorage.setItem(KEY_SECRET, secret)
  face('idle')
  $('group').hidden = false
  await connect()
}

function bind() {
  const nameEl = $('device-name')
  nameEl.value = state.name
  nameEl.addEventListener('change', () => {
    state.name = nameEl.value.trim() || defaultName()
    nameEl.value = state.name
    localStorage.setItem(KEY_NAME, state.name)
    state.hello?.send({id: state.deviceId, name: state.name})
  })
  nameEl.addEventListener('keydown', e => e.key === 'Enter' && nameEl.blur())

  $('btn-create').onclick = () => start(newSecret())
  $('paste-form').onsubmit = e => {
    e.preventDefault()
    const s = parseSecret($('paste-input').value)
    if (!s) return toast('페어링 링크가 올바르지 않습니다')
    start(s)
  }

  $('btn-clip').onclick = onSendClipboard
  $('btn-file').onclick = () => $('file-input').click()
  $('file-input').onchange = e => {
    stage(filesToItems(e.target.files))
    e.target.value = ''
  }
  $('btn-text').onclick = () => {
    face('text')
    $('text-input').focus()
  }
  $('btn-text-cancel').onclick = () => face('idle')
  $('btn-text-next').onclick = () => {
    const text = $('text-input').value
    if (!text.trim()) return
    $('text-input').value = ''
    face('idle')
    stage([{kind: 'text', text}])
  }
  $('btn-pick-cancel').onclick = () => {
    state.staged = null
    face('idle')
  }

  const drop = $('drop')
  let dragDepth = 0
  document.addEventListener('dragenter', e => {
    if (!state.secret || ![...e.dataTransfer.types].includes('Files')) return
    dragDepth++
    drop.classList.add('over')
  })
  document.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0
      drop.classList.remove('over')
    }
  })
  document.addEventListener('dragover', e => e.preventDefault())
  document.addEventListener('drop', e => {
    e.preventDefault()
    dragDepth = 0
    drop.classList.remove('over')
    if (state.secret) stage(filesToItems(e.dataTransfer.files))
  })
  document.addEventListener('paste', e => {
    if (!state.secret || e.target.matches('input, textarea')) return
    const files = e.clipboardData.files
    if (files.length) return stage(filesToItems(files))
    const text = e.clipboardData.getData('text/plain')
    if (text) stage([{kind: 'text', text}])
  })

  $('btn-clear').onclick = () => {
    if (!confirm('기록을 모두 지웁니다.')) return
    $('inbox').replaceChildren()
    $('inbox-empty').hidden = false
    $('btn-clear').hidden = true
    db.clear().catch(() => {})
  }
  $('btn-add').onclick = showPair
  $('btn-close-pair').onclick = () => $('pair').close()
  $('btn-copy-link').onclick = async () => {
    try {
      await navigator.clipboard.writeText(pairUrl())
      toast('링크를 복사했습니다')
    } catch {
      toast('복사할 수 없습니다')
    }
  }
  $('btn-reset').onclick = () => {
    if (!confirm('새 그룹을 만듭니다. 남길 기기는 다시 페어링해야 합니다.')) return
    state.known = {}
    saveKnown()
    start(newSecret()).then(showPair)
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.room && state.peers.size === 0) connect()
  })
}

async function init() {
  bind()
  loadHistory()
  const fromHash = parseSecret(location.hash)
  if (fromHash) {
    history.replaceState(null, '', location.pathname + location.search)
    await start(fromHash)
  } else {
    const saved = localStorage.getItem(KEY_SECRET)
    if (saved) await start(saved)
    else face('onboard')
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {})
  }
}

init()
