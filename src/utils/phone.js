// Indian mobile numbers are typed in many ways: "98765 43210", "+91-9876543210", "09876543210".
// For sign-in they are compared as the last 10 digits.
function normalizePhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length > 10 && (digits.startsWith('91') || digits.startsWith('0'))) return digits.slice(-10);
  return digits;
}

const isMobile = (value) => /^[6-9]\d{9}$/.test(normalizePhone(value));

module.exports = { normalizePhone, isMobile };
