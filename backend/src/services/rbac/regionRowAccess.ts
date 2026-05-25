import { ASP_CODE_REGION_MAP } from "@opencall/shared";
import type { Region } from "../../repositories/regionRepository.js";

export function aspCodesForRegion(region: Region): Set<string> {
  const wanted = new Set<string>();
  const regionCodeUpper = region.code.trim().toUpperCase();
  const regionNameUpper = region.name.trim().toUpperCase();

  if (regionCodeUpper) {
    wanted.add(regionCodeUpper);
  }

  for (const [aspCode, regionName] of Object.entries(ASP_CODE_REGION_MAP)) {
    const canonicalName = regionName.trim().toUpperCase();
    if (canonicalName === regionNameUpper || canonicalName === regionCodeUpper) {
      wanted.add(aspCode.toUpperCase());
    }
  }

  return wanted;
}

export function workLocationMatchesRegion(
  workLocation: string | null | undefined,
  region: Region,
): boolean {
  if (!workLocation) {
    return false;
  }
  const aspCode = workLocation.trim().toUpperCase();
  return aspCodesForRegion(region).has(aspCode);
}
