const usdFormatter = new Intl.NumberFormat("es-EC", {
  maximumFractionDigits: 0,
});

export function formatAdminUsd(value: string): string {
  const [integerPart = "0", decimalPart = ""] = value.split(".");
  const fraction = decimalPart.replace(/0+$/u, "");
  const integer = usdFormatter.format(BigInt(integerPart));
  return `USD\u00a0${integer}${fraction ? `,${fraction}` : ""}`;
}
