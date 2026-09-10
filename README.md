# simpleshare

Static web page that moves clipboard contents and files between your own devices over WebRTC. No server, no build step.

- Signaling via [Trystero](https://github.com/dmotz/trystero) (public Nostr relays), NAT traversal via public STUN only.
- A 32-byte random secret is the device group. Same secret, same room.
- Payloads are AES-GCM encrypted with a key derived (HKDF) from the secret, on top of Trystero's own SDP encryption.

## Usage

1. Open the page on one device and click **새 그룹 만들기**.
2. **기기 추가** shows a QR code. Scan it with another device, or copy the link and paste it into the other device's input.
3. Drop a file on the square, paste, or use **클립보드 보내기** / **파일 선택** / **텍스트 쓰기**. With more than one device connected you pick the recipient; with one it sends right away.
4. Received text and images are copied to the clipboard automatically when the browser allows it. Files get a **저장** button.
   Everything sent or received is kept in this browser (IndexedDB) until you remove it.
5. **그룹 재설정** rotates the secret. Re-pair the devices you want to keep.

## Deploy

Any static host works. For GitHub Pages, serve the repository root. HTTPS is required for clipboard APIs and the service worker.

## Limits

- Paired devices stay in the left list; offline ones are greyed and can be removed.
- Both tabs must be open. Backgrounded mobile tabs disconnect and rejoin when foregrounded.
- Firefox cannot read images from the clipboard. Safari requires a click to write to the clipboard.
- Symmetric NAT or blocked UDP (corporate networks, some LTE, VPN) will fail to connect. Use the same Wi-Fi.
