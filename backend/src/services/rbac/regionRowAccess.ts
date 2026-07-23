import { aspCodesForRegionIdentity } from "@opencall/shared";
import type { Region } from "../../repositories/regionRepository.js";

export function aspCodesForRegion(region: Region): Set<string> {
  return aspCodesForRegionIdentity(region.code, region.name);
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
