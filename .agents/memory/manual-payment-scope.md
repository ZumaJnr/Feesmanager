---
name: Manual payment scope
description: ShuleFees payment-entry behavior before a real M-Pesa integration exists.
---

Until an official M-Pesa integration is complete, payment entry records money already received and creates an internal ShuleFees receipt reference. Never present that reference as a provider transaction code or imply that the app requested or confirmed a transfer.

**Why:** The supplied prototype generated a random code and changed the fee balance without contacting M-Pesa. The app was built with that limitation made explicit.

**How to apply:** Keep payment copy clear that entries are manual bookkeeping. Only update a balance for a future M-Pesa flow after receiving and verifying the provider's confirmation.
