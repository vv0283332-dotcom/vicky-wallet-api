const MONO_BASE_URL = "https://api.withmono.com";

function monoKey() {
  const key = String(process.env.MONO_SECRET_KEY || "").trim();

  if (!key) {
    throw new Error("MONO_SECRET_KEY is not configured");
  }

  return key;
}

async function monoRequest(path, options = {}) {
  const response = await fetch(`${MONO_BASE_URL}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "mono-sec-key": monoKey(),
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error ||
      `Mono request failed with HTTP ${response.status}`;

    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

/*
 * Fetch the connected account.
 *
 * Mono returns financial information for an account after
 * the user has completed the Mono authorization flow.
 */
export async function getMonoAccount(accountId) {
  if (!accountId) {
    throw new Error("Mono account ID is required");
  }

  return monoRequest(
    `/v1/accounts/${encodeURIComponent(accountId)}`
  );
}

export async function getMonoBalance(accountId) {
  const result = await getMonoAccount(accountId);

  const account = result?.data || result?.account || result || {};

  return {
    provider: "mono",
    account_id: accountId,
    account_number: account.account_number || null,
    account_name: account.name || account.account_name || null,
    account_type: account.type || null,
    bank_name: account.institution?.name || account.bank_name || null,
    currency: account.currency || "NGN",
    balance: Number(account.balance || 0),
    raw: result
  };
}
