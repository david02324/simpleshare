import {joinRoom} from 'https://cdn.jsdelivr.net/npm/trystero@0.25.4/nostr/+esm'
import QRCode from 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm'

const APP_ID = 'simpleshare'
const KEY_SECRET = 'ss.secret'
const KEY_NAME = 'ss.name'
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
  room: null,
  actions: null,
  key: null,
  peers: new Map(),
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

function toast(msg, ms = 2500) {
  const el = $('toast')
  el.textContent = msg
  el.hidden = false
  clearTimeout(toast.t)
  toast.t = setTimeout(() => (el.hidden = true), ms)
}

async function deriveKey(secret) {
  const raw = b64u.decode(secret)
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey'])
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
  const iv = bytes.slice(0, 12)
  return new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv}, state.key, bytes.slice(12)))
}

function pairUrl() {
  return `${location.origin}${location.pathname}#k=${state.secret}`
}

function setSecret(secret) {
  state.secret = secret
  localStorage.setItem(KEY_SECRET, secret)
}

function newSecret() {
  return b64u.encode(crypto.getRandomValues(new Uint8Array(32)))
}

function parseSecret(input) {
  const m = String(input).trim().match(/#?k=([A-Za-z0-9_-]{43})$/) || String(input).trim().match(/^([A-Za-z0-9_-]{43})$/)
  return m ? m[1] : null
}

async function connect() {
  if (state.room) {
    state.room.leave()
    state.room = null
  }
  state.peers.clear()
  renderPeers()
  state.key = await deriveKey(state.secret)
  const roomId = await roomIdOf(state.secret)
  const room = joinRoom({appId: APP_ID, password: state.secret, rtcConfig: RTC, relayConfig: {redundancy: 5}}, roomId, {
    onJoinError: e => toast(`접속 실패: ${e?.error || e}`),
  })
  const hello = room.makeAction('hello')
  const clip = room.makeAction('clip')

  hello.onMessage = (data, {peerId}) => {
    state.peers.set(peerId, {name: String(data?.name || peerId.slice(0, 6))})
    renderPeers()
  }
  clip.onMessage = onClip
  clip.onReceiveProgress = (p, {peerId, metadata}) => {
    if (metadata?.type === 'image' && p < 1) setStatus(`수신 중 ${Math.round(p * 100)}%`)
  }

  room.onPeerJoin = peerId => {
    state.peers.set(peerId, {name: peerId.slice(0, 6)})
    renderPeers()
    hello.send({name: state.name}, {target: peerId})
  }
  room.onPeerLeave = peerId => {
    state.peers.delete(peerId)
    renderPeers()
  }

  state.room = room
  state.actions = {hello, clip}
  setStatus('연결 대기 중')
}

function setStatus(text) {
  $('status-dot').title = text
}

function renderPeers() {
  const ul = $('peer-list')
  const sel = $('target')
  const prev = sel.value
  ul.innerHTML = ''
  sel.innerHTML = '<option value="">모든 기기</option>'
  for (const [id, p] of state.peers) {
    const li = document.createElement('li')
    li.textContent = p.name
    ul.appendChild(li)
    const opt = document.createElement('option')
    opt.value = id
    opt.textContent = p.name
    sel.appendChild(opt)
  }
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev
  const n = state.peers.size
  $('status-dot').className = `dot ${n ? 'on' : ''}`
  setStatus(n ? `${n}대 연결됨` : '연결 대기 중')
  $('btn-send').disabled = n === 0
  $('btn-send-text').disabled = n === 0
}

async function readClipboard() {
  if (navigator.clipboard?.read) {
    try {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const mime = item.types.find(t => t.startsWith('image/'))
        if (mime) return {type: 'image', mime, blob: await item.getType(mime)}
      }
      for (const item of items) {
        if (item.types.includes('text/plain')) {
          return {type: 'text', text: await (await item.getType('text/plain')).text()}
        }
      }
    } catch (e) {
      if (e.name !== 'NotAllowedError' && e.name !== 'DataError') throw e
    }
  }
  const text = await navigator.clipboard.readText()
  return {type: 'text', text}
}

async function sendPayload(payload) {
  if (!state.actions || state.peers.size === 0) return toast('연결된 기기가 없습니다')
  const target = $('target').value || undefined
  const targetName = target ? state.peers.get(target)?.name : '모든 기기'
  let bytes, meta
  if (payload.type === 'image') {
    bytes = new Uint8Array(await payload.blob.arrayBuffer())
    meta = {type: 'image', mime: payload.mime}
  } else {
    if (!payload.text) return toast('클립보드가 비어 있습니다')
    bytes = enc.encode(payload.text)
    meta = {type: 'text'}
  }
  const sealed = await seal(bytes)
  const btn = $('btn-send')
  btn.disabled = true
  try {
    await state.actions.clip.send(sealed, {
      target,
      metadata: meta,
      onProgress: p => p < 1 && meta.type === 'image' && (btn.textContent = `전송 중 ${Math.round(p * 100)}%`),
    })
    toast(`${targetName}에 보냈습니다`)
  } finally {
    btn.textContent = '클립보드 보내기'
    btn.disabled = false
  }
}

async function onSendClipboard() {
  try {
    await sendPayload(await readClipboard())
  } catch (e) {
    toast(`클립보드 읽기 실패: ${e.message || e}`)
    $('app').querySelector('.manual').open = true
  }
}

async function onSendText() {
  const ta = $('manual-text')
  const text = ta.value
  if (!text.trim()) return
  await sendPayload({type: 'text', text})
  ta.value = ''
}

async function onClip(buf, {peerId, metadata}) {
  let bytes
  try {
    bytes = await open(buf)
  } catch {
    return toast('복호화 실패. 그룹이 다른 기기일 수 있습니다')
  }
  const from = state.peers.get(peerId)?.name || peerId.slice(0, 6)
  const item = metadata?.type === 'image'
    ? {type: 'image', mime: metadata.mime || 'image/png', blob: new Blob([bytes], {type: metadata.mime || 'image/png'})}
    : {type: 'text', text: dec.decode(bytes)}
  addInboxCard(item, from)
  const ok = await copyToClipboard(item)
  toast(ok ? `${from}에서 받아 클립보드에 복사했습니다` : `${from}에서 받았습니다. 복사 버튼을 누르세요`)
  renderPeers()
}

async function copyToClipboard(item) {
  try {
    if (item.type === 'text') {
      await navigator.clipboard.writeText(item.text)
    } else {
      const blob = item.mime === 'image/png' ? item.blob : await toPng(item.blob)
      await navigator.clipboard.write([new ClipboardItem({'image/png': blob})])
    }
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

function addInboxCard(item, from) {
  $('inbox-empty').hidden = true
  const card = document.createElement('article')
  card.className = 'card'
  const head = document.createElement('div')
  head.className = 'card-head'
  const who = document.createElement('span')
  who.textContent = `${from} · ${new Date().toLocaleTimeString()}`
  const copy = document.createElement('button')
  copy.textContent = '복사'
  copy.onclick = async () => toast((await copyToClipboard(item)) ? '복사했습니다' : '복사 실패')
  head.append(who, copy)
  card.appendChild(head)
  if (item.type === 'image') {
    const img = document.createElement('img')
    img.src = URL.createObjectURL(item.blob)
    img.alt = 'received image'
    card.appendChild(img)
  } else {
    const pre = document.createElement('pre')
    pre.textContent = item.text
    card.appendChild(pre)
  }
  $('inbox').prepend(card)
}

async function showPair() {
  const url = pairUrl()
  await QRCode.toCanvas($('qr'), url, {width: 240, margin: 1})
  $('pair').hidden = false
}

function showView() {
  const paired = !!state.secret
  $('onboarding').hidden = paired
  $('app').hidden = !paired
}

async function start(secret) {
  setSecret(secret)
  showView()
  await connect()
}

function bind() {
  $('device-name').value = state.name
  $('device-name').addEventListener('change', e => {
    state.name = e.target.value.trim() || defaultName()
    e.target.value = state.name
    localStorage.setItem(KEY_NAME, state.name)
    state.actions?.hello.send({name: state.name})
  })
  $('btn-create').onclick = () => start(newSecret())
  $('paste-form').onsubmit = e => {
    e.preventDefault()
    const s = parseSecret($('paste-input').value)
    if (!s) return toast('올바른 페어링 링크가 아닙니다')
    start(s)
  }
  $('btn-send').onclick = onSendClipboard
  $('btn-send-text').onclick = onSendText
  $('btn-add').onclick = showPair
  $('btn-close-pair').onclick = () => ($('pair').hidden = true)
  $('btn-copy-link').onclick = async () => {
    try {
      await navigator.clipboard.writeText(pairUrl())
      toast('링크를 복사했습니다')
    } catch {
      toast('복사 실패')
    }
  }
  $('btn-reset').onclick = () => {
    if (!confirm('새 그룹을 만듭니다. 다른 기기는 다시 페어링해야 합니다.')) return
    $('pair').hidden = true
    start(newSecret()).then(showPair)
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.secret && state.room && state.peers.size === 0) connect()
  })
}

async function init() {
  bind()
  const fromHash = parseSecret(location.hash)
  if (fromHash) {
    history.replaceState(null, '', location.pathname + location.search)
    await start(fromHash)
    return
  }
  const saved = localStorage.getItem(KEY_SECRET)
  showView()
  if (saved) await start(saved)
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {})
  }
}

init()
