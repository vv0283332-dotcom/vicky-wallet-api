import crypto from "node:crypto";
import { PaymentProvider } from "../provider-interface.js";

export class FlutterwaveProvider extends PaymentProvider {
  constructor() {
    super("flutterwave");

    this.secretKey = process.env.FLW_SECRET_KEY || "";
    this.baseUrl = "https://api.flutterwave.com/v3";
  }

  ensureConfigured() {
    if (!this.secretKey) {
      throw new Error("FLW_SECRET_KEY is not configured");
    }
  }

  async createDeposit({
    paymentId,
    amount,
    currency,
    email,
    name,
    redirectUrl
  }) {
    this.ensureConfigured();

    const txRef = `vicky_${paymentId}`;

    const response = await fetch(`${this.baseUrl}/payments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        "Content-Type": "application/json"
      },
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

    const data = await response.json();

    if (!response.ok || data.status !== "success") {
      throw new Error(
        data.message || "Flutterwave payment initialization failed"
      );
    }

    return {
      provider: this.name,
      payment_id: paymentId,
      provider_reference: txRef,
      checkout_url: data.data?.link || null,
      status: "pending"
    };
  }

  async verifyPayment(transactionId) {
    this.ensureConfigured();

    const response = await fetch(
      `${this.baseUrl}/transactions/${encodeURIComponent(transactionId)}/verify`,
      {
        headers: {
          Authorization: `Bearer ${this.secretKey}`
        }
      }
    );

    const data = await response.json();

    if (!response.ok || data.status !== "success") {
      return {
        verified: false,
        status: "failed",
        raw: data
      };
    }

    const transaction = data.data;

    return {
      verified:
        transaction?.status === "successful" &&
        transaction?.currency &&
        transaction?.amount != null,
      status: transaction?.status || "unknown",
      provider_reference: transaction?.tx_ref || null,
      amount: Number(transaction?.amount || 0),
      currency: transaction?.currency || null,
      raw: transaction
    };
  }

  verifyWebhook(signature, rawBody) {
    const secretHash = process.env.FLW_SECRET_HASH || "";

    if (!secretHash || !signature || !rawBody) {
      return false;
    }

    const expected = crypto
      .createHmac("sha256", secretHash)
      .update(rawBody)
      .digest("hex");

    try {
      return crypto.timingSafeEqual(
        Buffer.from(expected),
        Buffer.from(String(signature))
      );
    } catch {
      return false;
    }
  }
}
