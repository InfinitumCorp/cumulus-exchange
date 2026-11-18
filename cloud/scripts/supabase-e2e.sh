#!/bin/sh
# Local Supabase CLI only. Does not link, migrate, or deploy the live project.
set -eu
cd "$(dirname "$0")/.."
# Image pulls from public.ecr.aws are rate limited ("toomanyrequests") now and
# then. A failed start stops what it began; try again after a pause, up to 3 times.
started=0
attempt=1
while [ "$attempt" -le 3 ]; do
  if supabase start; then
    started=1
    break
  fi
  echo "supabase start failed (attempt $attempt of 3)"
  supabase stop --no-backup >/dev/null 2>&1 || true
  attempt=$((attempt + 1))
  if [ "$attempt" -le 3 ]; then sleep $((attempt * 15)); fi
done
if [ "$started" != "1" ]; then
  echo "supabase start failed 3 times"
  exit 1
fi
reset_ok=0
attempt=0
while [ "$attempt" -lt 3 ]; do
  if supabase db reset --local --no-seed --yes; then
    reset_ok=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 3
done
if [ "$reset_ok" != "1" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:54321/auth/v1/health || true)
  hook=$(docker exec supabase_db_cumulus-drive psql -U postgres -tAc "select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'custom_access_token_hook'" || true)
  bucket=$(docker exec supabase_db_cumulus-drive psql -U postgres -tAc "select case when public = false and file_size_limit = 50000000 then 'ok' else 'bad' end from storage.buckets where id = 'cumulus-drive'" || true)
  if [ "$code" != "200" ] || [ "$hook" = "1" ] || [ "$bucket" != "ok" ]; then
    echo "Local database reset failed"
    exit 1
  fi
fi
set -a
# shellcheck disable=SC2046
eval "$(supabase status -o env)"
set +a
umask 077
envfile="$(mktemp)"
pid=""
cleanup() {
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$envfile"
}
trap cleanup EXIT
cat > "$envfile" <<EOF
CUMULUS_AUTH_MODE=supabase
CUMULUS_REST_URL=http://kong:8000/rest/v1
CUMULUS_ANON_KEY=${ANON_KEY}
CUMULUS_SERVICE_ROLE_KEY=${SERVICE_ROLE_KEY}
CUMULUS_S3_ENDPOINT=http://kong:8000/storage/v1/s3
CUMULUS_S3_SIGN_HOST=kong:54321
CUMULUS_S3_ACCESS_KEY=${S3_PROTOCOL_ACCESS_KEY_ID}
CUMULUS_S3_SECRET_KEY=${S3_PROTOCOL_ACCESS_KEY_SECRET}
CUMULUS_S3_REGION=${S3_PROTOCOL_REGION}
CUMULUS_KMS_MASTER_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=
CUMULUS_SHARE_SECRET=local-stack-share-secret
CUMULUS_PUBLIC_BASE_URL=https://cloud.cumuluscloud.app
CUMULUS_JWKS_URL=http://kong:8000/auth/v1/.well-known/jwks.json
CUMULUS_JWT_ISSUER=${API_URL}/auth/v1
EOF
supabase functions serve --no-verify-jwt --env-file "$envfile" > /tmp/cumulus-functions.log 2>&1 &
pid=$!
ready=0
i=0
while [ "$i" -lt 45 ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "${API_URL}/functions/v1/drive/healthz" || true)
  if [ "$code" = "200" ]; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 2
done
if [ "$ready" != "1" ]; then
  echo "Drive function did not become ready"
  tail -n 80 /tmp/cumulus-functions.log || true
  exit 1
fi
CUMULUS_E2E_SUPABASE=1 node --test test/e2e-supabase.test.mjs
