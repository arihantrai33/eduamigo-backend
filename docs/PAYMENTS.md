# Online fee payments (Razorpay)

Each school collects fees into **its own Razorpay account**. EduAmigo never holds the money.

## Server setup (once)
- Set `DATA_ENCRYPTION_KEY` on Render to a long random value
  (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
  School payment keys are stored encrypted with it. Keep it safe: if it changes, every school must re-enter its keys.
  If it is not set, the key is derived from `JWT_SECRET` (rotating `JWT_SECRET` then also means re-entering keys).

## School setup (admin, in Settings → Online Fee Payments)
1. Razorpay Dashboard → Account & Settings → API Keys → generate keys. Start with **Test Mode** (`rzp_test_...`).
2. Paste Key ID and Key Secret into Settings.
3. Razorpay Dashboard → Webhooks → add the webhook URL shown in Settings, with events
   `payment.captured`, `order.paid`, `payment.failed`, and a webhook secret. Paste the same secret into Settings.
4. Click **Save and turn on**. Parents and students now see "Pay online" on outstanding fees.
5. Make a test payment with Razorpay's test UPI/card details, check the receipt, then switch to Live keys.

## How a payment is applied
- The server creates a Razorpay order for one fee (amount never more than the outstanding balance).
- After Checkout, the browser sends the signed result; the server checks the signature with the school's key secret.
- Razorpay also calls the webhook. Whichever arrives first applies the payment; the other finds it done.
  A payment is applied to a fee at most once, and concurrent payments cannot push a fee past its total.
- If money arrives but cannot be applied (for example the fee was already paid in cash), the order is marked
  **needs review**, admins and accountants are notified, and it is listed in Fee Collection for reconciliation or refund.

## Receipts
Every payment, cash or online, has a printable receipt (`/receipt/<feeId>/<receiptNo>`), available to fee staff,
the student and their parents.
