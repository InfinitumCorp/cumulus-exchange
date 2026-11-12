// © Infinitum Corporation®. All rights reserved.
//
// More Cumulus Drive storage, paid through Stripe. Plans are bought on the Cumulus billing hub
// (mail.cumuluscloud.app/api/billing), which signs the person in with Cumulus ID and opens Stripe
// Checkout. This app holds no Stripe key and makes no payment calls: these are plain links.

const BILLING_HUB = String(import.meta.env.VITE_BILLING_HUB_URL || "https://mail.cumuluscloud.app/api/billing").replace(/\/+$/, "");

const STORAGE_PLANS = [
  { id: "cumulus_drive_200", name: "200 GB", price: "$2.99 / month" },
  { id: "cumulus_drive_2tb", name: "2 TB", price: "$9.99 / month" },
] as const;

function billingHubUrl(action: "subscribe" | "manage", params: Record<string, string> = {}, origin = globalThis.location?.origin ?? "") {
  const query = new URLSearchParams({ ...params, ...(origin ? { return: `${origin}/` } : {}) });
  return `${BILLING_HUB}/${action}?${query}`;
}

export function StoragePlans() {
  return (
    <div className="card">
      <p className="lede">Need more room? Cumulus Drive storage is shared with Cumulus://Mail.</p>
      <div className="actions">
        {STORAGE_PLANS.map((plan) => (
          <a key={plan.id} className="btn" href={billingHubUrl("subscribe", { plan: plan.id })}>
            {plan.name} · {plan.price}
          </a>
        ))}
        <a className="btn" href={billingHubUrl("manage")}>Manage subscription</a>
      </div>
      <p className="lede">Pay securely with Stripe after you sign in with Cumulus ID. Cancel anytime.</p>
    </div>
  );
}
