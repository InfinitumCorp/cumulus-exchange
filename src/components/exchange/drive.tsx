import { useCallback, useEffect, useState } from "react";
import { HTMLTable } from "@blueprintjs/core";
import {
  DRIVE_API,
  DRIVE_BUCKET,
  driveHeaders,
  driveObjectUrl,
  previewShareHref,
} from "@/lib/exchange/drive-client";

type ObjectRow = { object_key: string; size_bytes: number; content_type: string };
type Usage = { usedBytes: number; maxBytes: number; maxFileBytes: number };

export function DriveView() {
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

function formatBytes(bytes: number) {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
