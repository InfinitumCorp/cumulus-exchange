import { useState } from "react";

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

export function DriveView() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
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

  async function enter(kind: "sign-in" | "sign-up") {
    try {
      await authCall(`/api/auth/${kind}/email`, email, password, name || email);
      await refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Sign-in failed");
    }
  }

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
          <div className="filters">
            <input className="field" aria-label="Name" placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />
            <input className="field" aria-label="Email" placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
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
