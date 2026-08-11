const MONO_BASE = "https://api.withmono.com";
const OPAY_BASE = "https://payapi.opayweb.com";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);

  let body = null;
  try {
    body = await response.json();
  } catch {}

  if (!response.ok) {
    const message =
      body?.message ||
      body?.error ||
      `Provider returned HTTP ${response.status}`;

    throw new Error(message);
  }

  return body;
}

/*
 * MONO
 *
 * Flow:
 * 1. Create Connect session
 * 2. User completes authorization
 * 3. Exchange returned code for permanent account ID
 * 4. Retrieve account details/balance
 */

export function monoConfigured() {
  return Boolean(process.env.MONO_SECRET_KEY);
}

export async function createMonoSession({
  institution,
  name,
  email,
  authMethod = "internet_banking"
}) {
  const secret = requireEnv("MONO_SECRET_KEY");

  return jsonRequest(`${MONO_BASE}/v2/connect/session`, {
    method: "POST",
    headers: {
      "mono-sec-key": secret,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      institution,
      auth_method: authMethod,
      scope: "financial_data",
      customer: {
        name,
        email
      }
    })
  });
}

export async function exchangeMonoCode(code) {
  const secret = requireEnv("MONO_SECRET_KEY");

  return jsonRequest(`${MONO_BASE}/v2/accounts/auth`, {
    method: "POST",
    headers: {
      "mono-sec-key": secret,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({ code })
  });
}

export async function getMonoAccount(accountId) {
  const secret = requireEnv("MONO_SECRET_KEY");

  return jsonRequest(`${MONO_BASE}/v2/accounts/${encodeURIComponent(accountId)}`, {
    method: "GET",
    headers: {
      "mono-sec-key": secret,
      Accept: "application/json"
    }
  });
}

/*
 * OPay Digital Wallet
 *
 * This is for an OPay business/digital-wallet integration
 * using official OPay credentials.
 */

export function opayConfigured() {
  return Boolean(
    process.env.OPAY_CLIENT_AUTH_KEY &&
    process.env.OPAY_MERCHANT_ID
  );
}

export async function getOpayWalletBalance(depositCode) {
  const clientAuthKey = requireEnv("OPAY_CLIENT_AUTH_KEY");
  const merchantId = requireEnv("OPAY_MERCHANT_ID");

  if (!depositCode) {
    throw new Error("OPay deposit code is required");
  }

  return jsonRequest(
    `${OPAY_BASE}/api/v2/third/depositcode/queryWalletBalance`,
    {
      method: "POST",
      headers: {
        clientAuthKey,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        opayMerchantId: merchantId,
        depositCode: String(depositCode)
      })
    }
  );
}

export function providerStatus() {
  return {
    mono: monoConfigured(),
    opay: opayConfigured()
  };
}
