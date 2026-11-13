/** Types for the Drive proxy (index.mjs), used by the console's proxy routes. */
export type DriveProxyEnv = Record<string, unknown> & {
  SUPABASE_FUNCTION_URL?: string;
  CUMULUS_CORS_ORIGINS?: string;
  CUMULUS_CLOUD_HOST?: string;
  CUMULUS_ID_HOST?: string;
  CUMULUS_MAIL_HOST?: string;
};
export function driveProxy(request: Request, env: DriveProxyEnv): Promise<Response | null>;
export function handleRequest(request: Request, env: DriveProxyEnv): Promise<Response>;
export function route(url: URL, env: DriveProxyEnv): { kind: "proxy"; path: string } | { kind: "asset" };
export const DEFAULT_CORS_ORIGINS: string[];
declare const worker: { fetch: typeof handleRequest };
export default worker;
