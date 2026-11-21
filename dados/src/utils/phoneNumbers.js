function normalizeNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

export function isExcludedWhatsAppSender(
  candidates = [],
  excludedNumbers = []
) {
  if (!Array.isArray(excludedNumbers)) return false;

  const excluded = new Set(
    excludedNumbers
      .map(normalizeNumber)
      .filter(number => /^\d{10,15}$/.test(number))
  );

  return candidates.some(candidate => {
    const number = normalizeNumber(candidate);
    return number && excluded.has(number);
  });
}
