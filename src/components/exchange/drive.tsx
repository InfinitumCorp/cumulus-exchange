import { useCallback, useEffect, useState } from "react";
import { HTMLTable } from "@blueprintjs/core";
import { SIGN_IN_PROVIDERS, signIn } from "@/lib/auth/client";
import {
  DRIVE_API,
  DRIVE_BUCKET,
  driveHeaders,
  driveObjectUrl,
  previewShareHref,
} from "@/lib/exchange/drive-client";

type ObjectRow = { object_key: string; size_bytes: number; content_type: string };
type Usage = { usedBytes: number; maxBytes: number; maxFileBytes: number };

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
  const [objects, setObjects] = useState<ObjectRow[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [notice, setNotice] = useState("Opening your Drive.");
  const [shareUrl, setShareUrl] = useState("");

  const load = useCallback(async (access: string) => {
    const headers = driveHeaders(access, "drive.read");
    const [list, meter] = await Promise.all([
      fetch(driveObjectUrl(DRIVE_BUCKET), { headers }),
      fetch(`${DRIVE_API}/v1/usage`, { headers }),
    ]);
    if (!list.ok || !meter.ok) {
      setNotice("Drive could not list this folder.");
      return;
    }
    const listed = (await list.json()) as { objects: ObjectRow[] };
    const measured = (await meter.json()) as Usage;
    setObjects(listed.objects);
    setUsage(measured);
    setNotice(listed.objects.length === 0 ? "This folder is empty." : "");
  }, []);

  useEffect(() => {
    let gone = false;
    fetch(`${DRIVE_API}/dev-session`)
      .then(async (response) => {
        if (!response.ok) throw new Error("no session");
        const body = (await response.json()) as { token: string };
        if (gone) return;
        setToken(body.token);
        await load(body.token);
      })
      .catch(() => {
        if (!gone) {
          setNotice("Drive is available in the local preview. It is not turned on for this server.");
        }
      });
    return () => {
      gone = true;
    };
  }, [load]);

  async function upload(file: File | undefined) {
    if (!file || !token) return;
    setNotice(`Uploading ${file.name}.`);
    const response = await fetch(driveObjectUrl(DRIVE_BUCKET, file.name), {
      method: "PUT",
      headers: {
        ...driveHeaders(token, "drive.write"),
        "content-type": file.type || "application/octet-stream",
      },
      body: await file.arrayBuffer(),
    });
    setNotice(response.ok ? `${file.name} is stored.` : "That upload was refused.");
    if (response.ok) await load(token);
  }

  async function download(key: string) {
    if (!token) return;
    const response = await fetch(driveObjectUrl(DRIVE_BUCKET, key), {
      headers: driveHeaders(token, "drive.read"),
    });
    if (!response.ok) {
      setNotice("Download failed.");
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = key;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function share(key: string) {
    if (!token) return;
    const response = await fetch(`${DRIVE_API}/v1/shares`, {
      method: "POST",
      headers: {
        ...driveHeaders(token, "drive.share"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ bucket: DRIVE_BUCKET, key, ttlSeconds: 900 }),
    });
    if (!response.ok) {
      setNotice("Could not create a share link.");
      return;
    }
    const body = (await response.json()) as { url: string };
    setShareUrl(body.url);
    setNotice("Share link expires in 15 minutes.");
  }

  async function remove(key: string) {
    if (!token) return;
    const response = await fetch(driveObjectUrl(DRIVE_BUCKET, key), {
      method: "DELETE",
      headers: driveHeaders(token, "drive.write"),
    });
    setNotice(response.ok ? `${key} was deleted.` : "Delete failed.");
    if (response.ok) await load(token);
  }

  const localShare = shareUrl ? previewShareHref(shareUrl) : "";

  return (
    <section className="pane">
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
          <input
            type="file"
            hidden
            onChange={(event) => {
              void upload(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </label>
      </div>
      {notice ? <p className="lede">{notice}</p> : null}
      {shareUrl ? (
        <p className="mono">
          <a href={localShare}>{localShare}</a>
        </p>
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
          {objects.map((object) => (
            <tr key={object.object_key}>
              <td>{object.object_key}</td>
              <td>{formatBytes(object.size_bytes)}</td>
              <td>{object.content_type}</td>
              <td>
                <div className="actions">
                  <button className="btn" type="button" onClick={() => void download(object.object_key)}>
                    Download
                  </button>
                  <button className="btn" type="button" onClick={() => void share(object.object_key)}>
                    Share
                  </button>
                  <button className="btn" type="button" onClick={() => void remove(object.object_key)}>
                    Delete
                  </button>
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

function SessionDriveView() {
  const [signedIn, setSignedIn] = useState(false);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [notice, setNotice] = useState("");
  const [consent, setConsent] = useState(false);
  const [hours, setHours] = useState(24);
  const [shares, setShares] = useState<Record<string, ShareRow[]>>({});

  async function refresh() {
    const response = await fetch("/api/drive/objects", { credentials: "include" });
    const body = (await response.json()) as { objects?: DriveFile[]; message?: string; error?: string };
    if (!response.ok) {
      setNotice(body.message ?? body.error ?? "Drive is unavailable");
      setSignedIn(false);
      return;
    }
    setSignedIn(true);
    setFiles(body.objects ?? []);
    setNotice("");
  }

  // Back from Cumulus ID the session cookie is already set, so look for files at once.
  useEffect(() => {
    void refresh().catch(() => setSignedIn(false));
  }, []);

  async function upload(file: File) {
    const response = await fetch("/api/drive/objects", {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": file.type || "application/octet-stream",
        "idempotency-key": crypto.randomUUID(),
        "x-display-name": file.name,
      },
      body: file,
    });
    const body = (await response.json()) as { message?: string; error?: string };
    if (!response.ok) setNotice(body.message ?? body.error ?? "Upload failed");
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
          </p>
        </div>
      </div>
      {notice ? <div className="notice">{notice}</div> : null}
      {!signedIn ? (
        <div className="card">
          <div className="actions">
            {SIGN_IN_PROVIDERS.map((p) => (
              <button
                key={p.providerId}
                className={p.create ? "btn" : "btn-primary"}
                type="button"
                onClick={() => {
                  void signIn(p.providerId, { callbackURL: "/" }).catch((err: unknown) =>
                    setNotice(err instanceof Error ? err.message : "Sign-in failed"),
                  );
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="actions">
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
