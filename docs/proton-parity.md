# Proton Drive parity

Cumulus://Cloud is the console in this repository. Cumulus Drive is the file product inside it. Two storage planes live here:

- **Session store** (`src/lib/drive`, `migrations/0002_cumulus_drive.sql`, `migrations/0003_drive_parity.sql`). Better Auth on this app. Bytes on a local directory. This is the account-scoped store.
- **Cloud plane** (`cloud/`). Filesystem ciphertext, SQLite or local Postgres metadata, Keycloak or a Supabase JWT that already carries a `cid`. The console uses this plane when `cloud/src/dev-preview.mjs` is mounted. It is not deployed by CI.

No separate Drive UI was required from another repository. Opt-in licensing, the 85% owner share, soulbound CDAT, and the Firmament preview are unchanged.

Sources checked for the public Proton Drive set: [proton.me/drive](https://proton.me/drive), [file storage](https://proton.me/drive/file-storage), [file sharing](https://proton.me/drive/file-sharing), [photo storage](https://proton.me/drive/photo-storage), [pricing](https://proton.me/drive/pricing), [web guide](https://proton.me/support/drive-web-guide), [version history](https://proton.me/support/version-history), and [Proton Drive for Business](https://proton.me/business/drive/features). Pricing and plan names below are Proton's, not Cumulus products.

| Feature | Proton | Cumulus | Status |
|---|---|---|---|
| End-to-end encrypted file bytes | Client encrypts before upload. Proton cannot read files. | The console seals with AES-GCM in the browser (`src/lib/drive/seal.ts`) when a Drive passphrase or the session password is set. The session store accepts `application/vnd.cumulus.sealed` only when the bytes match the `CMLS` header. The cloud plane still wraps whatever it receives with its server master key. | Added |
| Encrypted file names | Names are encrypted. | Sealed names use the `cmls1.` label. The server stores that opaque string. Search of those names runs in the browser after opening them. | Added |
| Encrypted metadata (size, dates, full MIME) | Folder structure and metadata are encrypted. | Size, time, and a coarse preview class (`image`, `pdf`, `text`, `video`, `note`, `other`) stay visible so quota, trash, and Photos can work without the key. | Deferred. A sealed manifest would hide size from quota accounting. |
| Upload and download | Yes | Both planes already uploaded and downloaded. | Existing |
| Large and chunked uploads | No practical file-size cap on paid plans. Uploads are chunked. | Session store assembles ordered parts, then runs the same quota and type checks (`upload-begin`, `upload-part`, `upload-complete`). The cap remains `CUMULUS_DRIVE_MAX_OBJECT_BYTES` (default 25 MiB) and the account quota. The cloud plane still accepts one body up to its per-file cap. | Added within the existing caps. Unlimited size is deferred. |
| Folder upload | Yes, including the browser folder picker. | Folder picker and drag-and-drop on the Drive pane. | Added |
| Folders | Yes | Session store has `drive_folder`. Cloud plane uses key prefixes and a hidden `.keep` marker. | Added |
| Image, PDF, text, and video preview | Yes, in the browser. | Preview uses the decrypted bytes in the existing card: image, PDF, video, and text. Video types `video/mp4` and `video/webm` are allowlisted by magic bytes. | Added |
| Thumbnails | Grid thumbnails. | The preview image is the thumbnail. A separate thumbnail index and a photo grid would be a new layout. | Deferred, so the file table stays as it is. |
| Share link | Yes | Bearer token (session store) and signed URL (cloud plane), with revoke. | Existing |
| Share password | Yes | Optional password. The hash is scrypt. The password is not stored. A missing or wrong password returns the same 401. | Added |
| Share expiry | Yes | Session links: 60 seconds to 7 days. Cloud links: 1 to 900 seconds, which is the existing cloud cap. | Existing, cloud cap unchanged |
| Download limit | Proton tracks and can limit downloads. | `maxDownloads` on both planes. The next read fails after the cap. | Added |
| Revoke a share | Yes | Already immediate for later reads. | Existing |
| Shared with me | Yes | Session grants and cloud `grants` rows. | Added |
| Invite by Cumulus://ID, viewer and editor | Proton invites by email with viewer or editor. | Session invites by email of an account in this process, or by a self-asserted `cid_` handle stored in `drive_identity`. Editor can upload a new version. Viewer can read. Cloud invites by `cid_` of another tenant. This process does not call `id.cumuluscloud.app` and does not treat that host as a cookie origin. | Added locally. Live directory lookup is deferred. |
| Version history and restore | Free: 10 versions / 7 days. Paid: up to 200 versions / 10 years. Restore keeps newer versions. | New uploads on the cloud plane can keep the previous blob (`x-cumulus-keep-version`). Session versions keep every stored generation, cap 20, and restore marks one current without deleting the others. Ten-year retention is not a storage promise here. | Added, with a 20-version cap. Long retention is deferred. |
| Trash and recovery | Delete moves to Trash. Restore or delete forever. | Trash hides the file and keeps quota. Restore puts it back. The existing DELETE still removes the bytes. | Added |
| Storage quota and usage | Meter in the product. Free tier 5 GB as of this writing. | Cloud usage line was already on the Drive title. Session responses now include `quota`, and the Drive sentence shows it. Quota is still the configured byte cap, not a Proton plan. | Existing on the cloud plane. Added on the session store. |
| Photos | Photos view, albums, automatic phone backup. | Photos is a filter of the same file table (`preview_class=image` or an image type). | Added as a filter. Automatic phone backup and albums are deferred. They need the mobile clients. |
| Docs and Sheets | Proton Docs and Proton Sheets, end-to-end encrypted, with their own history. | A note is a text file sealed before upload. Real-time collaborative documents and spreadsheets are separate products. | Notes added. Docs and Sheets are deferred. |
| Search | Search names in the client. | The search field filters opened names in the browser. Plaintext labels can also be queried on the session API. The server cannot search a sealed name. | Added |
| Favorites | Star files. | `starred` on both planes. | Added |
| Recent | Recent files. | Lists stay ordered by newest first. The Files control clears the Photos, Starred, and Trash filters. | Existing order. Added as a filter reset. |
| Offline and PWA | Desktop files available offline. | The platform PWA injector already serves the shell. A second service worker is not registered. Offline file bodies are not cached, so plaintext is not written beside the sealed upload. | Deferred. Design note is `syncDesign()` in `src/lib/drive/sync-design.ts`. |
| Desktop and mobile sync | Official apps sync folders and back up photos. | No sync client ships here. The same module states the contract: watch a folder, send sealed chunks, pull versions, and cache only ciphertext. | Deferred |
| 2FA and security keys | Account-level, shared with Proton Mail. Hardware keys on higher plans. | Status is `deferred` and names `id.cumuluscloud.app` as the authority. This console does not enroll authenticators and does not call that host. | Deferred |
| Session management | See sessions and revoke them. | The session store lists this app's Better Auth sessions and can delete one. The raw session token is not returned. The cloud plane has no Better Auth session table. | Added for the session store |
| Activity log | Business activity and share download counts. | `drive_audit` already recorded uploads, downloads, and shares. The session API now returns the latest rows, including trash, restore, star, grants, and mail handoff. The cloud plane records `activity` rows. | Added |
| Large-file handoff to Mail | Proton Mail can send a Drive file instead of a giant attachment. | `mail` on the session store creates the expiring share and returns `status: deferred`, `channel: cumulus-mail`. Nothing is sent. Mail delivery is another repository. The cloud Drive button does the same with a share link and says delivery is deferred. | Added as a handoff. Delivery is deferred. |
| Business admin, enforced org 2FA, Sentinel | Proton for Business. | One console. No org admin. | Deferred |
| Link malware scanning | Proton says shared links are checked. | No scanner is wired, and this change does not pretend to scan. | Deferred |
| Opt-in data license, 85% owner share, CDAT, Firmament | Not Proton features. | Left in place. | Existing |

## Deferred on purpose

- Calling `id.cumuluscloud.app` for 2FA, security keys, or a live directory. `src/lib/auth/origins.ts` refuses that host as a trusted origin. Handles stored here are self-asserted.
- Desktop, iOS, and Android sync binaries, and automatic photo backup.
- An offline ciphertext cache and a second service worker.
- Proton Docs and Proton Sheets.
- Raising the cloud share lifetime past 15 minutes, or removing the per-file and quota caps.
- Hiding file sizes from the server.
- Sending mail.
