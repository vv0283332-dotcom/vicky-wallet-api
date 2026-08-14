import crypto from "node:crypto";
import { PaymentProvider } from "../provider-interface.js";

export class FlutterwaveProvider extends PaymentProvider {
  constructor() {
    super("flutterwave");

    this.secretKey = String(process.env.FLW_SECRET_KEY || "").trim();
    this.secretHash = String(process.env.FLW_SECRET_HASH || "").trim();
    this.baseUrl = "https://api.flutterwave.com/v3";
  }

  ensureConfigured() {
    if (!this.secretKey) {
      throw new Error("FLW_SECRET_KEY is not configured");
    }
  }

  async request(path, options = {}) {
    this.ensureConfigured();

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });

    const text = await response.text();

    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {
        status: "error",
        message: text || "Invalid Flutterwave response"
      };
    }

    if (!response.ok) {
      const error = new Error(
        data?.message ||
        `Flutterwave request failed with HTTP ${response.status}`
      );

      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  async createDeposit({
    paymentId,
    amount,
    currency,
    email,
    name,
    redirectUrl
  }) {
    const txRef = `vicky_${paymentId}`;

    const data = await this.request("/payments", {
      method: "POST",
      body: JSON.stringify({
        tx_ref: txRef,
        amount,
        currency,
        redirect_url: redirectUrl,
        customer: {
          email,
          name
        },
        customizations: {
          title: "Vicky Pay",
          description: "Wallet deposit"
        }
      })
    });

    if (data.status !== "success" || !data.data?.link) {
      throw new Error(
        data.message || "Flutterwave payment initialization failed"
      );
    }

    return {
      provider: this.name,
      payment_id: paymentId,
      provider_reference: txRef,
      checkout_url: data.data.link,
      status: "pending"
    };
  }

  async verifyPayment(transactionId) {
    const idValue = String(transactionId || "").trim();

    if (!idValue) {
      return {
        verified: false,
        status: "failed",
        reason: "Missing Flutterwave transaction ID"
      };
    }

    try {
      const data = await this.request(
        `/transactions/${encodeURIComponent(idValue)}/verify`,
        { method: "GET" }
      );

      const transaction = data.data;

      if (!transaction) {
        return {
          verified: false,
          status: "failed"
        };
      }

      return {
        verified:
          String(transaction.status).toLowerCase() === "successful" &&
          Number(transaction.amount) > 0 &&
          /^[A-Z]{3}$/.test(
            String(transaction.currency || "").toUpperCase()
          ),

        status: String(
          transaction.status || "unknown"
        ).toLowerCase(),

        provider_reference: transaction.tx_ref || null,
        amount: Number(transaction.amount || 0),
        currency: String(
          transaction.currency || ""
        ).toUpperCase(),
        transaction_id: transaction.id,
        raw: transaction
      };
    } catch (error) {
      return {
        verified: false,
        status: "failed",
        reason: error.message
      };
    }
  }

  async getBanks(country = "NG") {
    const data = await this.request(
      `/banks/${encodeURIComponent(String(country).toUpperCase())}`,
      { method: "GET" }
    );

    return data?.data || [];
  }

  async resolveAccount({
    accountNumber,
    bankCode
  }) {
    if (!accountNumber || !bankCode) {
      throw new Error("Bank code and account number are required");
    }

    const data = await this.request("/accounts/resolve", {
      method: "POST",
      body: JSON.stringify({
        account_number: String(accountNumber).trim(),
        account_bank: String(bankCode).trim()
      })
    });

    if (data.status !== "success" || !data.data) {
      throw new Error(
        data.message || "Unable to resolve bank account"
      );
    }

    return {
      account_number: data.data.account_number,
      account_name: data.data.account_name,
      raw: data.data
    };
  }

  async createWithdrawal({
    paymentId,
    amount,
    currency,
    accountNumber,
    bankCode,
    beneficiaryName,
    narration,
    callbackUrl
  }) {
    const reference = `vicky_wd_${paymentId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

    const data = await this.request("/transfers", {
      method: "POST",
      body: JSON.stringify({
        account_bank: String(bankCode),
        account_number: String(accountNumber),
        amount: Number(amount),
        currency: String(currency).toUpperCase(),
        debit_currency: String(currency).toUpperCase(),
        beneficiary_name: beneficiaryName,
        reference,
        narration: narration || "Vicky Pay withdrawal",
        callback_url: callbackUrl
      })
    });

    if (data.status !== "success" || !data.data) {
      throw new Error(
        data.message || "Flutterwave withdrawal initialization failed"
      );
    }

    return {
      provider: this.name,
      payment_id: paymentId,
      provider_reference: reference,
      transfer_id: data.data.id,
      status: String(data.data.status || "NEW").toLowerCase(),
      raw: data.data
    };
  }

  async verifyWithdrawal({ transferId }) {
    if (!transferId) {
      throw new Error("Flutterwave transfer ID is required");
    }

    const data = await this.request(
      `/transfers/${encodeURIComponent(String(transferId))}`,
      { method: "GET" }
    );

    const transfer = data?.data || {};

    const status = String(
      transfer.status || "UNKNOWN"
    ).toLowerCase();

    return {
      verified: ["successful", "failed", "cancelled"].includes(status),
      successful: status === "successful",
      failed: ["failed", "cancelled"].includes(status),
      transfer_id: transfer.id || transferId,
      provider_reference: transfer.reference || null,
      status,
      amount: Number(transfer.amount || 0),
      currency: String(
        transfer.currency || ""
      ).toUpperCase(),
      raw: transfer
    };
  }

  verifyWebhook({
    verifHash,
    flutterwaveSignature,
    rawBody
  }) {
    if (!this.secretHash) return false;

    if (verifHash) {
      const incoming = String(verifHash).trim();

      if (incoming.length !== this.secretHash.length) {
        return false;
      }

      return crypto.timingSafeEqual(
        Buffer.from(incoming),
        Buffer.from(this.secretHash)
      );
    }

    if (flutterwaveSignature && rawBody) {
      const expected = crypto
        .createHmac("sha256", this.secretHash)
        .update(rawBody)
        .digest("base64");

      const incoming = String(flutterwaveSignature);

      if (expected.length !== incoming.length) {
        return false;
      }

      return crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(incoming)
      );
    }

    return false;
  }
}
