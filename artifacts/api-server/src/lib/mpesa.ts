type DarajaEnvironment = "sandbox" | "production";

type TokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
};

type StkPushResponse = {
  ResponseCode?: unknown;
  ResponseDescription?: unknown;
  MerchantRequestID?: unknown;
  CheckoutRequestID?: unknown;
  errorMessage?: unknown;
};

type StkQueryResponse = {
  ResponseCode?: unknown;
  CheckoutRequestID?: unknown;
  ResultCode?: unknown;
  ResultDesc?: unknown;
  ResponseDescription?: unknown;
  errorMessage?: unknown;
};

type DarajaCredentials = {
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  environment: DarajaEnvironment;
};

let cachedAccessToken: string | undefined;
let accessTokenExpiresAt = 0;

function getEnvironment(): DarajaEnvironment {
  const configuredEnvironment = process.env.MPESA_ENVIRONMENT?.trim().toLowerCase();
  if (!configuredEnvironment || configuredEnvironment === "sandbox") {
    return "sandbox";
  }
  if (configuredEnvironment === "production") {
    return "production";
  }
  throw new Error("MPESA_ENVIRONMENT must be either sandbox or production.");
}

function getCredentials(): DarajaCredentials | undefined {
  const consumerKey = process.env.MPESA_CONSUMER_KEY?.trim();
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET?.trim();
  const shortcode = process.env.MPESA_SHORTCODE?.trim();
  const passkey = process.env.MPESA_PASSKEY?.trim();

  if (!consumerKey || !consumerSecret || !shortcode || !passkey) {
    return undefined;
  }

  return {
    consumerKey,
    consumerSecret,
    shortcode,
    passkey,
    environment: getEnvironment(),
  };
}

function getCallbackUrl(): string | undefined {
  const configuredUrl = process.env.MPESA_CALLBACK_URL?.trim();
  if (configuredUrl) {
    try {
      const url = new URL(configuredUrl);
      return url.protocol === "https:" ? url.toString() : undefined;
    } catch {
      return undefined;
    }
  }

  const domain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (!domain) return undefined;

  try {
    const url = new URL(`https://${domain}`);
    return `${url.origin}/api/mpesa/callback`;
  } catch {
    return undefined;
  }
}

export function getMpesaConfig() {
  const environment = getEnvironment();
  const hasCredentials = getCredentials() !== undefined;
  const hasCallback = getCallbackUrl() !== undefined;
  const livePaymentsEnabled = false;
  const available =
    environment === "sandbox" && hasCredentials && hasCallback;

  let message = "Sandbox is ready. Test transactions only; no real money is collected.";
  if (environment === "production") {
    message = "Live M-Pesa prompts are disabled until staff sign-in is enabled.";
  } else if (!hasCredentials) {
    message = "M-Pesa credentials are not configured.";
  } else if (!hasCallback) {
    message = "A public HTTPS callback URL is not available.";
  }

  return {
    available,
    environment,
    livePaymentsEnabled,
    message,
  };
}

export function normalizeKenyanPhoneNumber(rawPhone: string): string | undefined {
  let digits = rawPhone.replace(/\D/g, "");
  if (digits.startsWith("0")) {
    digits = `254${digits.slice(1)}`;
  } else if (digits.startsWith("7") || digits.startsWith("1")) {
    digits = `254${digits}`;
  }

  return /^254[17]\d{8}$/.test(digits) ? digits : undefined;
}

function requireCredentials(): DarajaCredentials {
  const credentials = getCredentials();
  if (!credentials) {
    throw new Error("M-Pesa credentials are not configured.");
  }
  if (credentials.environment !== "sandbox") {
    throw new Error("Live M-Pesa prompts are disabled until staff sign-in is enabled.");
  }
  return credentials;
}

function getBaseUrl(environment: DarajaEnvironment): string {
  return environment === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
}

function makeTimestamp(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}${value("month")}${value("day")}${value("hour")}${value("minute")}${value("second")}`;
}

async function parseResponse<T>(response: Response): Promise<T> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error("Safaricom returned an unreadable response.");
  }

  if (!response.ok) {
    const body = data as { errorMessage?: unknown; error_description?: unknown };
    const providerMessage =
      typeof body.errorMessage === "string"
        ? body.errorMessage
        : typeof body.error_description === "string"
          ? body.error_description
          : undefined;
    throw new Error(providerMessage ?? `Safaricom returned HTTP ${response.status}.`);
  }

  return data as T;
}

async function getAccessToken(credentials: DarajaCredentials): Promise<string> {
  if (cachedAccessToken && Date.now() < accessTokenExpiresAt) {
    return cachedAccessToken;
  }

  const authorization = Buffer.from(
    `${credentials.consumerKey}:${credentials.consumerSecret}`,
  ).toString("base64");
  const response = await fetch(
    `${getBaseUrl(credentials.environment)}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${authorization}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  const token = await parseResponse<TokenResponse>(response);
  if (typeof token.access_token !== "string" || !token.access_token) {
    throw new Error("Safaricom did not return an access token.");
  }

  const expiresIn =
    typeof token.expires_in === "string" || typeof token.expires_in === "number"
      ? Number(token.expires_in)
      : 3_600;
  cachedAccessToken = token.access_token;
  accessTokenExpiresAt = Date.now() + Math.max(expiresIn - 60, 60) * 1_000;
  return cachedAccessToken;
}

function makePassword(credentials: DarajaCredentials, timestamp: string): string {
  return Buffer.from(
    `${credentials.shortcode}${credentials.passkey}${timestamp}`,
  ).toString("base64");
}

export async function startStkPush(input: {
  amount: number;
  phone: string;
  accountReference: string;
}) {
  const credentials = requireCredentials();
  const callbackUrl = getCallbackUrl();
  if (!callbackUrl) {
    throw new Error("A public HTTPS callback URL is not available.");
  }

  const timestamp = makeTimestamp();
  const accessToken = await getAccessToken(credentials);
  const response = await fetch(
    `${getBaseUrl(credentials.environment)}/mpesa/stkpush/v1/processrequest`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        BusinessShortCode: credentials.shortcode,
        Password: makePassword(credentials, timestamp),
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: input.amount,
        PartyA: input.phone,
        PartyB: credentials.shortcode,
        PhoneNumber: input.phone,
        CallBackURL: callbackUrl,
        AccountReference: input.accountReference,
        TransactionDesc: "School fees payment",
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const result = await parseResponse<StkPushResponse>(response);

  if (
    String(result.ResponseCode) !== "0" ||
    typeof result.CheckoutRequestID !== "string" ||
    typeof result.MerchantRequestID !== "string"
  ) {
    const description =
      typeof result.errorMessage === "string"
        ? result.errorMessage
        : typeof result.ResponseDescription === "string"
          ? result.ResponseDescription
          : "Safaricom did not accept the payment prompt.";
    throw new Error(description);
  }

  return {
    checkoutRequestId: result.CheckoutRequestID,
    merchantRequestId: result.MerchantRequestID,
  };
}

export async function queryStkPush(checkoutRequestId: string) {
  const credentials = requireCredentials();
  const timestamp = makeTimestamp();
  const accessToken = await getAccessToken(credentials);
  const response = await fetch(
    `${getBaseUrl(credentials.environment)}/mpesa/stkpushquery/v1/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        BusinessShortCode: credentials.shortcode,
        Password: makePassword(credentials, timestamp),
        Timestamp: timestamp,
        CheckoutRequestID: checkoutRequestId,
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  return parseResponse<StkQueryResponse>(response);
}
