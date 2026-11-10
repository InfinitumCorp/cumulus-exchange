import { useCallback, useEffect, useState } from "react";
import { HTMLTable } from "@blueprintjs/core";
import {
  DRIVE_API,
  DRIVE_BUCKET,
  driveHeaders,
  driveObjectUrl,
  previewShareHref,
} from "@/lib/exchange/drive-client";
import { nameMatches, previewClassFor } from "@/lib/drive/preview-class";
import { deriveDriveKey, openContent, openName, SEAL_MEDIA_TYPE, sealContent, sealName, toArrayBuffer } from "@/lib/drive/seal";

type ObjectRow = {
  object_key: string;
  size_bytes: number;
  content_type: string;
  sealed_name?: string | null;
  preview_class?: string | null;
  starred?: number;
};
type Usage = { usedBytes: number; maxBytes: number; maxFileBytes: number };
type Listed = ObjectRow & { label: string };
type Preview = { name: string; url: string; kind: string; text?: string };

/**
 * Cloud-plane preview when `/api/drive/dev-session` answers.
 * Otherwise the Better Auth session store (local bytes + PGLite).
 * Supabase mode stays in `cloud/` and is not replaced by the session store.
 */
export function DriveView() {
  const [mode, setMode] = useState<"pending" | "cloud" | "session">("pending");

  useEffect(() => {
    let gone = false;
    fetch(`${DRIVE_API}/dev-session`)
      .then(async (response) => {
        if (!response.ok) throw new Error("no session");
        const body = (await response.json()) as { token?: string };
        if (!body.token) throw new Error("no session");
        if (!gone) setMode("cloud");
      })
      .catch(() => {
        if (!gone) setMode("session");
      });
    return () => {
      gone = true;
    };
  }, []);

  if (mode === "cloud") return <CloudDriveView />;
  if (mode === "session") return <SessionDriveView />;
  return (
    <section className="pane">
      <p className="lede">Opening your Drive.</p>
    </section>
  );
}

function CloudDriveView() {
  const [token, setToken] = useState<string | null>(null);
  const [objects, setObjects] = useState<Listed[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [notice, setNotice] = useState("Opening your Drive.");
  const [shareUrl, setShareUrl] = useState("");
  const [view, setView] = useState("files");
  const [prefix, setPrefix] = useState("");
  const [query, setQuery] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [key, setKey] = useState<CryptoKey | null>(null);
  const [sharePassword, setSharePassword] = useState("");
  const [maxDownloads, setMaxDownloads] = useState("");
  const [invite, setInvite] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [extra, setExtra] = useState("");
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [folderName, setFolderName] = useState("");

  const load = useCallback(async (access: string, nextView: string, driveKey: CryptoKey | null) => {
    const headers = driveHeaders(access, "drive.read");
    const listUrl = `${driveObjectUrl(DRIVE_BUCKET)}?view=${encodeURIComponent(nextView === "photos" || nextView === "starred" || nextView === "trash" ? nextView : "active")}`;
    const [list, meter] = await Promise.all([
      fetch(listUrl, { headers }),
      fetch(`${DRIVE_API}/v1/usage`, { headers }),
    ]);
    if (!list.ok || !meter.ok) {
      setNotice("Drive could not list this folder.");
      return;
    }
    const listed = (await list.json()) as { objects: ObjectRow[] };
    const measured = (await meter.json()) as Usage;
    const labeled = await Promise.all(listed.objects.map(async (object) => ({
      ...object,
      label: await visibleName(object, driveKey),
    })));
    setObjects(labeled);
    setUsage(measured);
    setNotice(labeled.length === 0 ? "This folder is empty." : "");
  }, []);

  useEffect(() => {
    let gone = false;
    fetch(`${DRIVE_API}/dev-session`)
      .then(async (response) => {
        if (!response.ok) throw new Error("no session");
        const body = (await response.json()) as { token: string };
        if (gone) return;
        setToken(body.token);
        await load(body.token, "files", null);
      })
      .catch(() => {
        if (!gone) setNotice("Drive is available in the local preview. It is not turned on for this server.");
      });
    return () => {
      gone = true;
    };
  }, [load]);

  async function unlock() {
    if (!passphrase) return;
    const next = await deriveDriveKey(passphrase, "cumulus-drive");
    setKey(next);
    setPassphrase("");
    if (token) await load(token, view, next);
    setNotice("New uploads are sealed on this device before they leave it.");
  }

  async function upload(file: File | undefined, folder = prefix) {
    if (!file || !token) return;
    setNotice(`Uploading ${file.name}.`);
    const raw = new Uint8Array(await file.arrayBuffer());
    const previewClass = previewClassFor(file.type || "application/octet-stream", file.name);
    let body: Uint8Array = raw;
    let media = file.type || "application/octet-stream";
    let objectKey = `${folder}${file.name}`;
    const headers: Record<string, string> = {
      ...driveHeaders(token, "drive.write"),
      "x-cumulus-keep-version": "1",
      "x-cumulus-preview-class": previewClass,
    };
    if (key) {
      body = await sealContent(key, raw);
      media = SEAL_MEDIA_TYPE;
      objectKey = `${folder}files/${crypto.randomUUID()}`;
      headers["x-cumulus-sealed-name"] = await sealName(key, `${folder}${file.name}`);
    }
    headers["content-type"] = media;
    const response = await fetch(driveObjectUrl(DRIVE_BUCKET, objectKey), { method: "PUT", headers, body: new Blob([toArrayBuffer(body)]) });
    setNotice(response.ok ? `${file.name} is stored.` : "That upload was refused.");
    if (response.ok) await load(token, view, key);
  }

  async function downloadBytes(objectKey: string) {
    if (!token) return null;
    const response = await fetch(driveObjectUrl(DRIVE_BUCKET, objectKey), { headers: driveHeaders(token, "drive.read") });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const type = response.headers.get("content-type") || "application/octet-stream";
    if (key && (type === SEAL_MEDIA_TYPE || (bytes[0] === 0x43 && bytes[1] === 0x4d))) {
      return { bytes: await openContent(key, bytes), type: "application/octet-stream" };
    }
    return { bytes, type };
  }

  async function download(object: Listed) {
    const file = await downloadBytes(object.object_key);
    if (!file) {
      setNotice("Download failed.");
      return;
    }
    saveBlob(file.bytes, object.label, file.type);
  }

  async function openPreview(object: Listed) {
    const file = await downloadBytes(object.object_key);
    if (!file) {
      setNotice("Preview failed.");
      return;
    }
    if (preview) URL.revokeObjectURL(preview.url);
    const kind = object.preview_class || previewClassFor(file.type, object.label);
    const text = kind === "text" || kind === "note" ? new TextDecoder().decode(file.bytes) : "";
    setPreview({ name: object.label, url: URL.createObjectURL(new Blob([toArrayBuffer(file.bytes)], { type: file.type })), kind, text });
  }

  async function share(objectKey: string) {
    if (!token) return;
    const response = await fetch(`${DRIVE_API}/v1/shares`, {
      method: "POST",
      headers: { ...driveHeaders(token, "drive.share"), "content-type": "application/json" },
      body: JSON.stringify({
        bucket: DRIVE_BUCKET,
        key: objectKey,
        ttlSeconds: 900,
        password: sharePassword || undefined,
        maxDownloads: maxDownloads ? Number(maxDownloads) : undefined,
      }),
    });
    if (!response.ok) {
      setNotice("Could not create a share link.");
      return;
    }
    const body = (await response.json()) as { url: string };
    setShareUrl(body.url);
    setNotice("Share link expires in 15 minutes.");
  }

  async function parity(op: string, fields: Record<string, unknown>, purpose: "drive.read" | "drive.write" = "drive.write") {
    if (!token) return null;
    const response = await fetch(`${DRIVE_API}/v1/parity`, {
      method: "POST",
      headers: { ...driveHeaders(token, purpose), "content-type": "application/json" },
      body: JSON.stringify({ op, bucket: DRIVE_BUCKET, ...fields }),
    });
    if (!response.ok) {
      setNotice("That Drive action was refused.");
      return null;
    }
    return response.json();
  }

  async function showActivity() {
    if (!token) return;
    const response = await fetch(`${DRIVE_API}/v1/parity?op=activity`, { headers: driveHeaders(token, "drive.read") });
    const security = await fetch(`${DRIVE_API}/v1/parity?op=security`, { headers: driveHeaders(token, "drive.read") });
    const events = response.ok ? ((await response.json()) as { events: { action: string; object_key: string | null; at: string }[] }).events : [];
    const report = security.ok ? ((await security.json()) as { reason?: string }) : {};
    setExtra([report.reason, ...events.slice(0, 8).map((event) => `${event.at} ${event.action} ${event.object_key ?? ""}`)].filter(Boolean).join(" · "));
  }

  const shown = filterListing(objects, prefix, query, view);
  const localShare = shareUrl ? previewShareHref(shareUrl) : "";

  return (
    <section
      className="pane"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const file = event.dataTransfer.files?.[0];
        if (file) void upload(file);
      }}
    >
      <div className="pane-head">
        <div>
          <h1 className="pane-title">Drive</h1>
          <p className="lede">
            Files stay in Cumulus Drive for {usage ? formatBytes(usage.usedBytes) : "…"} of{" "}
            {usage ? formatBytes(usage.maxBytes) : "the"} quota. Per file cap{" "}
            {usage ? formatBytes(usage.maxFileBytes) : "50 MB"}. Upload calls {DRIVE_API}.
          </p>
        </div>
      </div>
      <div className="actions">
        <label className="btn-primary">
          Upload
          <input type="file" hidden onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} />
        </label>
        <label className="btn">
          Folder
          <input
            type="file"
            hidden
            multiple
            ref={(node) => { if (node) node.setAttribute("webkitdirectory", ""); }}
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              void (async () => {
                for (const file of files) {
                  const relative = file.webkitRelativePath || file.name;
                  const slash = relative.lastIndexOf("/");
                  const folder = slash >= 0 ? relative.slice(0, slash + 1) : "";
                  await upload(file, prefix + folder);
                }
              })();
              event.target.value = "";
            }}
          />
        </label>
        <button className="btn" type="button" onClick={() => { if (!folderName.trim()) return; void upload(new File(["{}"], ".keep", { type: "application/json" }), `${prefix}${folderName.trim()}/`); setFolderName(""); }}>
          New folder
        </button>
        <button className="btn" type="button" onClick={() => setShowNote((value) => !value)}>Note</button>
        {(["files", "photos", "starred", "trash"] as const).map((item) => (
          <button key={item} className="btn" type="button" onClick={() => { setView(item); if (token) void load(token, item, key); }}>
            {item[0].toUpperCase() + item.slice(1)}
          </button>
        ))}
        <button className="btn" type="button" onClick={() => void showActivity()}>Activity</button>
        {prefix ? <button className="btn" type="button" onClick={() => setPrefix(prefix.replace(/[^/]+\/$/, ""))}>Up</button> : null}
      </div>
      <div className="filters">
        <input className="search" aria-label="Search files" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
        <input className="field" aria-label="Drive passphrase" placeholder="Drive passphrase" type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
        <button className="btn" type="button" onClick={() => void unlock()}>Unlock</button>
        <input className="field" aria-label="Share password" placeholder="Share password" value={sharePassword} onChange={(event) => setSharePassword(event.target.value)} />
        <input className="field" aria-label="Download limit" placeholder="Download limit" value={maxDownloads} onChange={(event) => setMaxDownloads(event.target.value)} />
        <input className="field" aria-label="Folder name" placeholder="Folder name" value={folderName} onChange={(event) => setFolderName(event.target.value)} />
        <input className="field" aria-label="Cumulus ID" placeholder="cid_name" value={invite} onChange={(event) => setInvite(event.target.value)} />
      </div>
      {notice ? <p className="lede">{notice}</p> : null}
      {prefix ? <p className="mono">{prefix}</p> : null}
      {shareUrl ? <p className="mono"><a href={localShare}>{localShare}</a></p> : null}
      {extra ? <p className="lede">{extra}</p> : null}
      {showNote ? (
        <div className="card">
          <textarea className="field" aria-label="Note" placeholder="Encrypted note" value={note} onChange={(event) => setNote(event.target.value)} />
          <button className="btn" type="button" onClick={() => void upload(new File([note], `note-${Date.now()}.note`, { type: "text/plain" }))}>Save note</button>
        </div>
      ) : null}
      {preview ? (
        <div className="card">
          <p className="row-title">{preview.name}</p>
          {preview.kind === "image" ? <img alt="" src={preview.url} /> : null}
          {preview.kind === "pdf" ? <iframe title={preview.name} src={preview.url} /> : null}
          {preview.kind === "video" ? <video controls src={preview.url} /> : null}
          {preview.kind === "text" || preview.kind === "note" ? <pre className="mono">{preview.text}</pre> : null}
        </div>
      ) : null}
      <HTMLTable compact striped className="drive-table">
        <thead>
          <tr>
            <th>Object</th>
            <th>Size</th>
            <th>Type</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {shown.folders.map((folder) => (
            <tr key={folder}>
              <td>{folder}/</td>
              <td />
              <td>folder</td>
              <td><button className="btn" type="button" onClick={() => setPrefix(`${prefix}${folder}/`)}>Open</button></td>
            </tr>
          ))}
          {shown.files.map((object) => (
            <tr key={object.object_key}>
              <td>{object.label}</td>
              <td>{formatBytes(object.size_bytes)}</td>
              <td>{object.preview_class || object.content_type}</td>
              <td>
                <div className="actions">
                  <button className="btn" type="button" onClick={() => void download(object)}>Download</button>
                  <button className="btn" type="button" onClick={() => void openPreview(object)}>Preview</button>
                  <button className="btn" type="button" onClick={() => void share(object.object_key)}>Share</button>
                  <button className="btn" type="button" onClick={() => { void (async () => { await parity("star", { key: object.object_key, starred: object.starred ? 0 : 1 }); if (token) await load(token, view, key); })(); }}>Star</button>
                  <button className="btn" type="button" onClick={() => { void (async () => { await parity(view === "trash" ? "restore" : "trash", { key: object.object_key }); if (token) await load(token, view, key); })(); }}>{view === "trash" ? "Restore" : "Trash"}</button>
                  <button className="btn" type="button" onClick={() => void parity("invite", { key: object.object_key, cid: invite, role: "viewer" })}>Invite</button>
                  <button className="btn" type="button" onClick={() => { void share(object.object_key); setNotice("Mail delivery is deferred. The share link is the handoff."); }}>Mail</button>
                  <button className="btn" type="button" onClick={async () => {
                    const body = await parity("versions", { key: object.object_key }, "drive.write");
                    const count = (body as { versions?: unknown[] } | null)?.versions?.length ?? 0;
                    setNotice(count ? `${count} earlier version${count === 1 ? "" : "s"}.` : "No earlier version.");
                  }}>History</button>
                  <button className="btn" type="button" onClick={async () => {
                    if (!token) return;
                    const response = await fetch(driveObjectUrl(DRIVE_BUCKET, object.object_key), { method: "DELETE", headers: driveHeaders(token, "drive.write") });
                    setNotice(response.ok ? `${object.label} was deleted.` : "Delete failed.");
                    if (response.ok) await load(token, view, key);
                  }}>Delete</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </HTMLTable>
    </section>
  );
}


interface DriveFile {
  id: string;
  byteSize: number;
  mediaType: string;
  displayName: string;
  status: string;
}

interface ShareRow {
  id: string;
  expiresAt: string;
  revokedAt: string | null;
  token?: string;
}

async function authCall(path: string, email: string, password: string, name: string) {
  const response = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, name }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? "Sign-in failed");
  }
}

function SessionDriveView() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [signedIn, setSignedIn] = useState(false);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [notice, setNotice] = useState("");
  const [consent, setConsent] = useState(false);
  const [hours, setHours] = useState(24);
  const [shares, setShares] = useState<Record<string, ShareRow[]>>({});
  const [driveKey, setDriveKey] = useState<CryptoKey | null>(null);
  const [quotaText, setQuotaText] = useState("");
  const [listView, setListView] = useState("files");

  async function refresh(next: CryptoKey | null = driveKey, nextView = listView) {
    const query = nextView === "files" ? "" : `?view=${nextView}`;
    const response = await fetch(`/api/drive/objects${query}`, { credentials: "include" });
    const body = (await response.json()) as {
      objects?: DriveFile[];
      quota?: { bytesStored: number; quotaBytes: number };
      message?: string;
      error?: string;
    };
    if (!response.ok) {
      setNotice(body.message ?? body.error ?? "Drive is unavailable");
      setSignedIn(false);
      return;
    }
    setSignedIn(true);
    const objects = body.objects ?? [];
    if (next) {
      for (const file of objects) {
        if (file.displayName.startsWith("cmls1.")) {
          try {
            file.displayName = await openName(next, file.displayName);
          } catch {
            file.displayName = "Sealed file";
          }
        }
      }
    }
    setFiles(objects);
    if (body.quota) setQuotaText(`${formatBytes(body.quota.bytesStored)} of ${formatBytes(body.quota.quotaBytes)}`);
    setNotice("");
  }

  async function enter(kind: "sign-in" | "sign-up") {
    try {
      await authCall(`/api/auth/${kind}/email`, email, password, name || email);
      const next = password ? await deriveDriveKey(password, email) : null;
      setDriveKey(next);
      await refresh(next);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Sign-in failed");
    }
  }

  async function upload(file: File) {
    let payload: BodyInit = file;
    let media = file.type || "application/octet-stream";
    let displayName = file.name;
    if (driveKey) {
      const sealed = await sealContent(driveKey, new Uint8Array(await file.arrayBuffer()));
      payload = new Blob([toArrayBuffer(sealed)]);
      media = SEAL_MEDIA_TYPE;
      displayName = await sealName(driveKey, file.name);
    }
    const response = await fetch("/api/drive/objects", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": media,
        "idempotency-key": crypto.randomUUID(),
        "x-display-name": displayName,
        "x-preview-class": previewClassFor(file.type || "application/octet-stream", file.name),
      },
      body: payload,
    });
    const body = (await response.json()) as { message?: string; error?: string };
    if (!response.ok) setNotice(body.message ?? body.error ?? "Upload failed");
    await refresh();
  }

  async function sessionOp(op: string, fields: Record<string, unknown>) {
    const response = await fetch("/api/drive/ops", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op, ...fields }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      setNotice(body.message ?? "That Drive action was refused.");
      return;
    }
    await refresh();
  }

  async function download(id: string, filename: string) {
    const response = await fetch(`/api/drive/objects/${id}`, { credentials: "include" });
    if (!response.ok) {
      setNotice("Download failed");
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function remove(id: string) {
    await fetch(`/api/drive/objects/${id}`, { method: "DELETE", credentials: "include" });
    await refresh();
  }

  async function share(id: string) {
    const response = await fetch(`/api/drive/objects/${id}/shares`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consent: true, expiresInSeconds: hours * 3600 }),
    });
    const body = (await response.json()) as ShareRow & { message?: string; error?: string };
    if (!response.ok) {
      setNotice(body.message ?? body.error ?? "Share failed");
      return;
    }
    setShares((current) => ({ ...current, [id]: [body, ...(current[id] ?? [])] }));
    setConsent(false);
  }

  async function revoke(objectId: string, shareId: string) {
    await fetch(`/api/drive/shares/${shareId}`, { method: "DELETE", credentials: "include" });
    setShares((current) => ({
      ...current,
      [objectId]: (current[objectId] ?? []).map((item) =>
        item.id === shareId ? { ...item, revokedAt: new Date().toISOString(), token: undefined } : item,
      ),
    }));
  }

  return (
    <section className="pane">
      <div className="pane-head">
        <div>
          <h1 className="pane-title">Cumulus Drive</h1>
          <p className="lede">
            Private files for the signed-in account. Bytes stay on this server&apos;s disk. A share
            link is one file, expires, and stops working as soon as you revoke it. The demo ledger
            is a separate browser preview.
            {quotaText ? ` ${quotaText} used.` : ""}
          </p>
        </div>
      </div>
      {notice ? <div className="notice">{notice}</div> : null}
      {!signedIn ? (
        <div className="card">
          <div className="filters">
            <input className="field" aria-label="Name" placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />
            <input className="field" aria-label="Email" placeholder="demo.you@cumuluscloud.app" value={email} onChange={(event) => setEmail(event.target.value)} />
            <input className="field" aria-label="Password" placeholder="Password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </div>
          <div className="actions">
            <button className="btn-primary" type="button" onClick={() => enter("sign-in")}>
              Sign in
            </button>
            <button className="btn" type="button" onClick={() => enter("sign-up")}>
              Create account
            </button>
            <button className="btn" type="button" onClick={() => refresh()}>
              Load my files
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="actions">
            {(["files", "photos", "starred", "trash"] as const).map((item) => (
              <button key={item} className="btn" type="button" onClick={() => { setListView(item); void refresh(driveKey, item); }}>
                {item[0].toUpperCase() + item.slice(1)}
              </button>
            ))}
            <label className="btn">
              Upload
              <input
                type="file"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                  event.target.value = "";
                }}
              />
            </label>
            <label className="lede">
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /> I
              consent to mint one expiring link for a file I select
            </label>
            <input
              className="field"
              aria-label="Share hours"
              type="number"
              min={1}
              max={168}
              value={hours}
              onChange={(event) => setHours(Number(event.target.value))}
            />
          </div>
          <div className="list">
            {files.length === 0 ? <p className="lede">No files yet.</p> : null}
            {files.map((file) => (
              <div key={file.id} className="row">
                <span>
                  <span className="row-title">{file.displayName}</span>
                  <span className="row-meta">
                    {" "}
                    {file.mediaType} · {file.byteSize} bytes · {file.status}
                  </span>
                  {(shares[file.id] ?? []).map((share) => (
                    <span key={share.id} className="row-meta">
                      {" "}
                      {share.revokedAt ? "revoked" : `token ${share.token ?? "hidden"} until ${share.expiresAt.slice(0, 16)}`}
                      {!share.revokedAt ? (
                        <button className="btn-quiet" type="button" onClick={() => revoke(file.id, share.id)}>
                          Revoke
                        </button>
                      ) : null}
                    </span>
                  ))}
                </span>
                <span className="actions">
                  <button className="btn" type="button" onClick={() => download(file.id, file.displayName)}>
                    Download
                  </button>
                  <button className="btn" type="button" disabled={!consent || file.status !== "stored"} onClick={() => share(file.id)}>
                    Share
                  </button>
                  <button className="btn" type="button" onClick={() => sessionOp(listView === "trash" ? "restore" : "trash", { id: file.id })}>
                    {listView === "trash" ? "Restore" : "Trash"}
                  </button>
                  <button className="btn" type="button" onClick={() => sessionOp("star", { id: file.id, starred: true })}>
                    Star
                  </button>
                  <button className="btn" type="button" onClick={() => remove(file.id)}>
                    Delete
                  </button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

async function visibleName(object: { object_key: string; sealed_name?: string | null }, driveKey: CryptoKey | null) {
  if (object.sealed_name && driveKey) {
    try {
      return await openName(driveKey, object.sealed_name);
    } catch {
      return "Sealed file";
    }
  }
  return object.sealed_name ? "Sealed file" : object.object_key;
}

function filterListing(objects: Listed[], prefix: string, query: string, view: string) {
  const folders = new Set<string>();
  const files: Listed[] = [];
  for (const object of objects) {
    const name = object.label;
    if (name.endsWith("/.keep")) {
      const folder = name.slice(prefix.length).replace(/\/\.keep$/, "");
      if (folder && !folder.includes("/")) folders.add(folder);
      continue;
    }
    if (view !== "trash" && !name.startsWith(prefix)) continue;
    const rest = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    const slash = rest.indexOf("/");
    if (slash >= 0) folders.add(rest.slice(0, slash));
    else if (nameMatches(rest, query)) files.push({ ...object, label: rest });
  }
  return { folders: [...folders], files };
}

function saveBlob(bytes: Uint8Array, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
