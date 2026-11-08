# Cumulus://Cloud landing page

Public landing page for https://cumuluscloud.app/ (also www). Static files in `public/`, served by the Worker `cumulus-site` on Cloudflare (Workers Static Assets, no code).

The page says Cumulus://Cloud is in development and sign-in is not open. Replace it with the app when the app is deployed to this domain.

Public access: the account-wide "All Workers" Cloudflare Access app gates every Worker. The "Cumulus://Cloud (public)" Access app bypasses it for these domains.

```sh
npx wrangler deploy
```
