export const ASP_CODE_REGION_MAP: Record<string, string> = {
  ASPS01461: "CHENNAI",
  ASPS01463: "VELLORE",
  ASPS01465: "SALEM",
  ASPS01489: "KANCHIPURAM",
  ASPS01511: "HOSUR",
};

export function regionNameForAspCode(aspCode: string): string {
  return ASP_CODE_REGION_MAP[aspCode] ?? "Unknown Region";
}

/**
 * Every ASP work-location code a region covers, resolved from the region's
 * code and name (rows carry ASP codes like "ASPS01511" while region records
 * carry codes like "HOS" — comparing them directly never matches; this is the
 * one translation both the backend row-access checks and the frontend
 * frozen-region overlay must share).
 */
export function aspCodesForRegionIdentity(
  regionCode: string,
  regionName: string,
): Set<string> {
  const wanted = new Set<string>();
  const regionCodeUpper = regionCode.trim().toUpperCase();
  const regionNameUpper = regionName.trim().toUpperCase();

  if (regionCodeUpper) {
    wanted.add(regionCodeUpper);
  }

  for (const [aspCode, mappedName] of Object.entries(ASP_CODE_REGION_MAP)) {
    const canonicalName = mappedName.trim().toUpperCase();
    if (canonicalName === regionNameUpper || canonicalName === regionCodeUpper) {
      wanted.add(aspCode.toUpperCase());
    }
  }

  return wanted;
}
