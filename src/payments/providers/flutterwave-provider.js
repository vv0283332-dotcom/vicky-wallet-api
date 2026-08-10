import crypto from "node:crypto";
import { PaymentProvider } from "../provider-interface.js";

export class FlutterwaveProvider extends PaymentProvider {
  constructor() {
    super("flutterwave");

    this.secretKey = String(
      process.env.FLW_SECRET_KEY || ""
    ).trim();

    this.secretHash = String(
      process.env.FLW_SECRET_HASH || ""
    ).trim();

    this.baseUrl = "https://api.flutterwave.com/v3";
  }

  ensureConfigured() {
    if (!this.secretKey) {
      throw new Error("FLW_SECRET_KEY is not configured");
    }
  }

  async request(path, options = {}) {
    this.ensureConfigured();

    const response = await fetch(
      `${this.baseUrl}${path}`,
      {
        ...options,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          "Content-Type": "application/json",
          ...(options.headers || {})
        }
      }
    );

    const text = await response.text();

    let data;

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {
        status: "error",
        message: text || "Invalid Flutterwave response"
      };
    }

    if (!response.ok) {
      throw new Error(
        data.message ||
        `Flutterwave request failed with HTTP ${response.status}`
      );
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
          title: "Vicky Wallet",
          description: "Wallet deposit"
        }
      })
    });

    if (data.status !== "success" || !data.data?.link) {
      throw new Error(
        data.message ||
        "Flutterwave payment initialization failed"
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
        {
          method: "GET"
        }
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
          transaction.status === "successful" &&
          Number(transaction.amount) > 0 &&
          /^[A-Z]{3}$/.test(
            String(transaction.currency || "").toUpperCase()
          ),

        status: String(
          transaction.status || "unknown"
        ).toLowerCase(),

        provider_reference:
          transaction.tx_ref || null,

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

  verifyWebhook({
    verifHash,
    flutterwaveSignature,
    rawBody
  }) {
    if (!this.secretHash) {
      return false;
    }

    /*
     * Flutterwave v3 webhooks may provide verif-hash.
     * Compare it directly with the configured secret hash.
     */
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

    /*
     * Newer webhook implementations may provide
     * flutterwave-signature using HMAC-SHA256/base64.
     */
    if (flutterwaveSignature && rawBody) {
      const expected = crypto
        .createHmac("sha256", this.secretHash)
        .update(rawBody)
        .digest("base64");

      if (
        expected.length !==
        String(flutterwaveSignature).length
      ) {
        return false;
      }

      return crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(String(flutterwaveSignature))
      );
    }

    return false;
  }
}
