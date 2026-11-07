/**
 * Prometheus text exposition. Names here are the contract for
 * deploy/monitoring/alerts.yml. Gauges are filled by the server from the
 * on-disk catalog. Counters live in process memory and reset on restart.
 */

export const GAUGE_NAMES = [
  "cumulus_up",
  "cumulus_ready",
  "cumulus_tenants",
  "cumulus_buckets",
  "cumulus_objects",
  "cumulus_shares",
  "cumulus_bytes_stored",
  "cumulus_last_backup_timestamp_seconds",
];

export const COUNTER_NAMES = ["cumulus_auth_failures_total", "cumulus_quota_denied_total"];

const HELP = {
  cumulus_up: "1 while the control plane process is serving.",
  cumulus_ready: "1 after the most recent readiness check succeeded.",
  cumulus_tenants: "Tenants persisted in the catalog.",
  cumulus_buckets: "Buckets persisted in the catalog.",
  cumulus_objects: "Objects persisted in the catalog.",
  cumulus_shares: "Share ACL entries persisted in the catalog.",
  cumulus_bytes_stored: "Plaintext bytes charged against tenant quotas.",
  cumulus_last_backup_timestamp_seconds: "Unix time of the last backup stamp, or 0 if none.",
  cumulus_auth_failures_total: "Rejected authentication attempts.",
  cumulus_quota_denied_total: "Uploads rejected because a persisted quota was exceeded.",
  cumulus_http_requests_total: "HTTP requests by plane, method, and status code.",
};

function escapeLabel(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function labelKey(labels) {
  const names = Object.keys(labels).sort();
  return names.map((name) => `${name}=${labels[name]}`).join(",");
}

function formatLabels(labels) {
  const names = Object.keys(labels).sort();
  if (names.length === 0) return "";
  return `{${names.map((name) => `${name}="${escapeLabel(labels[name])}"`).join(",")}}`;
}

export function createMetrics() {
  /** @type {Map<string, { name: string, labels: Record<string, string>, value: number }>} */
  const counters = new Map();
  /** @type {Map<string, { name: string, labels: Record<string, string>, value: number }>} */
  const gauges = new Map();

  for (const name of GAUGE_NAMES) gauges.set(name, { name, labels: {}, value: 0 });
  for (const name of COUNTER_NAMES) counters.set(name, { name, labels: {}, value: 0 });
  gauges.set("cumulus_up", { name: "cumulus_up", labels: {}, value: 1 });

  return {
    inc(name, labels = {}, by = 1) {
      const key = `${name}|${labelKey(labels)}`;
      const current = counters.get(key);
      counters.set(key, { name, labels, value: (current?.value ?? 0) + by });
    },
    set(name, value, labels = {}) {
      gauges.set(`${name}|${labelKey(labels)}`, { name, labels, value });
    },
    authFailure() {
      this.inc("cumulus_auth_failures_total");
    },
    quotaDenied() {
      this.inc("cumulus_quota_denied_total");
    },
    request(plane, method, code) {
      this.inc("cumulus_http_requests_total", {
        plane,
        method: String(method || "GET").toUpperCase(),
        code: String(code),
      });
    },
    render() {
      const lines = [];
      const groups = new Map();
      const push = (sample) => {
        if (!groups.has(sample.name)) groups.set(sample.name, []);
        groups.get(sample.name).push(sample);
      };
      for (const sample of gauges.values()) push(sample);
      for (const sample of counters.values()) push(sample);
      for (const [name, samples] of groups) {
        const kind = name.endsWith("_total") ? "counter" : "gauge";
        lines.push(`# HELP ${name} ${HELP[name] ?? name}`);
        lines.push(`# TYPE ${name} ${kind}`);
        for (const sample of samples) {
          lines.push(`${name}${formatLabels(sample.labels)} ${sample.value}`);
        }
      }
      return `${lines.join("\n")}\n`;
    },
  };
}
