import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";

const realmPath = fileURLToPath(new URL("../keycloak/cumulus-realm.json", import.meta.url));

test("Keycloak realm matches cumuluscloud.app and carries a CID claim", async () => {
  const config = loadConfig({});
  const raw = await readFile(realmPath, "utf8");
  const realm = JSON.parse(raw);
  assert.equal(realm.realm, "cumulus");
  assert.equal(realm.enabled, true);
  assert.equal(realm.sslRequired, "external");
  assert.equal(realm.attributes.frontendUrl, `https://${config.idHost}`);
  assert.equal(realm.users.length, 0);
  assert.equal(raw.includes("clientSecret"), false);
  assert.equal(raw.includes('"*"'), false);
  for (const client of realm.clients) {
    assert.equal(client.webOrigins.includes("*"), false);
  }

  const cloud = realm.clients.find((client) => client.clientId === "cumulus-cloud");
  const mail = realm.clients.find((client) => client.clientId === "cumulus-mail");
  assert.ok(cloud);
  assert.ok(mail);
  assert.equal(cloud.publicClient, true);
  assert.equal(cloud.directAccessGrantsEnabled, false);
  assert.deepEqual(cloud.redirectUris, [`https://${config.cloudHost}/*`]);
  assert.deepEqual(cloud.webOrigins, [`https://${config.cloudHost}`]);
  assert.deepEqual(mail.redirectUris, [`https://${config.mailHost}/*`]);
  assert.deepEqual(mail.webOrigins, [`https://${config.mailHost}`]);
  assert.equal(cloud.attributes["pkce.code.challenge.method"], "S256");

  const cid = cloud.protocolMappers.find((mapper) => mapper.name === "cid");
  const purposes = cloud.protocolMappers.find((mapper) => mapper.name === "purposes");
  const audience = cloud.protocolMappers.find((mapper) => mapper.name === "audience");
  assert.equal(cid.config["claim.name"], "cid");
  assert.equal(cid.config["access.token.claim"], "true");
  assert.equal(purposes.config["claim.name"], "purposes");
  assert.equal(purposes.config.multivalued, "true");
  assert.equal(audience.config["included.custom.audience"], config.audience);
  assert.deepEqual(
    realm.roles.realm.map((role) => role.name).sort(),
    ["drive.read", "drive.share", "drive.write"],
  );
});
