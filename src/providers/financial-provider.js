import crypto from "node:crypto";

function required(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is not configured`);
  }

  return value;
}

/*
 * Generic provider interface.
 *
 * Real bank connections must use the provider's
 * authorization/consent flow. Never collect a user's
 * banking password inside Vicky Pay.
 */

export function providerStatus() {
  return {
    adamma: Boolean(process.env.ADAMMA_API_KEY),
    opay: Boolean(
      process.env.OPAY_CLIENT_AUTH_KEY &&
      process.env.OPAY_MERCHANT_ID
    )
  };
}

export async function getAdammaAccounts(accessToken) {
  if (!accessToken) {
    throw new Error("Bank authorization is required");
  }

  const response = await fetch(
    "https://api.adamma.com/v1/accounts",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Adamma-Version": "2026-05-01",
        Accept: "application/json"
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `Bank provider returned HTTP ${response.status}`
    );
  }

  return response.json();
}

/*
 * OPay Business/Digital Wallet integration.
 *
 * OPay requires its own authentication/encryption/signing
 * scheme and credentials. This function intentionally refuses
 * to guess those credentials or pretend to access a personal
 * OPay account.
 */
export function assertOpayConfigured() {
  required("OPAY_CLIENT_AUTH_KEY");
  required("OPAY_MERCHANT_ID");
}

export function createConnectionId() {
  return crypto.randomUUID();
}
