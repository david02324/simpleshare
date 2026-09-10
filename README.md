# simpleshare

Static web page that shares your clipboard (text and images) between your own devices over WebRTC. No server, no build step.

- Signaling via [Trystero](https://github.com/dmotz/trystero) (public Nostr relays), NAT traversal via public STUN only.
- A 32-byte random secret is the device group. Same secret, same room.
- Payloads are AES-GCM encrypted with a key derived (HKDF) from the secret, on top of Trystero's own SDP encryption.

## Usage

1. Open the page on one device and click **새 그룹 만들기**.
2. **기기 추가** shows a QR code. Scan it with another device, or copy the link and paste it into the other device's input.
3. Click **클립보드 보내기** to send whatever is on your clipboard. Received items appear in the inbox and are copied automatically when the browser allows it.
4. **그룹 재설정** rotates the secret. Re-pair the devices you want to keep.

## Deploy

Any static host works. For GitHub Pages, serve the repository root. HTTPS is required for clipboard APIs and the service worker.

## Limits

- Both tabs must be open. Backgrounded mobile tabs disconnect and rejoin when foregrounded.
- Firefox cannot read images from the clipboard. Safari requires a click to write to the clipboard.
- Symmetric NAT or blocked UDP (corporate networks, some LTE, VPN) will fail to connect. Use the same Wi-Fi.
