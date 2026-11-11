/**
 * Cumulus://ID (id.cumuluscloud.app) is the account authority for 2FA and
 * security keys. This console does not enroll authenticators and does not
 * treat that host as a trusted cookie origin.
 */
export interface AccountSecurityStatus {
  twoFactor: "deferred";
  securityKeys: "deferred";
  authority: "id.cumuluscloud.app";
  reason: string;
}

export function accountSecurityStatus(): AccountSecurityStatus {
  return {
    twoFactor: "deferred",
    securityKeys: "deferred",
    authority: "id.cumuluscloud.app",
    reason:
      "Two-factor authentication and hardware security keys are enrolled at Cumulus://ID. This repository refuses id.cumuluscloud.app as a trusted session origin, so it records the delegation and does not call that host.",
  };
}
