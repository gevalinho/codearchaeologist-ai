// A deliberately compact legacy pricing policy with branch order that matters.
export function invoiceTotal(subtotalCents, customerYears, promoCode) {
  if (!Number.isInteger(subtotalCents) || subtotalCents < 0) throw new Error("Invalid subtotal");
  let discountPercent = 0;
  if (customerYears >= 5) discountPercent = 15;
  else if (promoCode === "WELCOME") discountPercent = 10;
  const discounted = Math.round(subtotalCents * (100 - discountPercent) / 100);
  const shipping = discounted >= 5000 ? 0 : 799;
  return discounted + shipping;
}
