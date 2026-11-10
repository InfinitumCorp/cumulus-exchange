/**
 * Desktop, mobile, and offline sync are separate clients. This module is the
 * contract they would implement. Nothing here opens a socket or writes a file.
 */
export interface SyncAdapter {
  status: "deferred";
  platforms: Array<"desktop" | "ios" | "android" | "offline">;
  reason: string;
}

export function syncDesign(): SyncAdapter {
  return {
    status: "deferred",
    platforms: ["desktop", "ios", "android", "offline"],
    reason:
      "A sync client is not in this repository. The console seals file bytes before upload. An offline cache must store only those sealed bytes, and it must not register a second service worker beside the platform PWA injector. Desktop and mobile apps would watch a local folder, chunk uploads, and pull version history. Automatic photo backup needs those mobile apps.",
  };
}
